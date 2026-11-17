import type { Evidence, Usage } from '../types'
import { SESSION_ID, type HarnessAdapter, type RepairInput } from './types'
import { runCommand } from './command'
import { withOutputInstruction } from '../output'
import { codexMcpArgs } from '../tools'
import type { ExecuteInput } from './types'
import { attachUsage, parseUsage } from './usage'
import { randomUUID } from 'node:crypto'

export interface CodexStreamSummary {
  /** Text of the last agent message. */
  result?: string
  isError: boolean
  /** From `turn.failed` or a top-level `error` event. */
  error?: string
  usage?: Usage
  /** From `thread.started` — `codex exec resume <id>` continues the thread. */
  threadId?: string
}

/**
 * Read a `codex exec --json` transcript: one event per line. The final
 * `agent_message` is the answer, `turn.completed` carries usage, and
 * `turn.failed` / `error` mean the turn did not finish. Returns null when the
 * output is not JSONL at all (an older codex, or a crash before any event).
 */
export function parseCodexStream(output: string): CodexStreamSummary | null {
  let result: string | undefined
  let error: string | undefined
  let sawEvent = false
  let completed = false
  let threadId: string | undefined

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof event.type !== 'string') continue
    sawEvent = true

    if (event.type === 'thread.started') {
      if (typeof event.thread_id === 'string' && SESSION_ID.test(event.thread_id)) threadId = event.thread_id
    } else if (event.type === 'item.completed') {
      const item = event.item as { type?: string; text?: string } | undefined
      if (item?.type === 'agent_message' && typeof item.text === 'string') result = item.text
    } else if (event.type === 'turn.completed') {
      completed = true
    } else if (event.type === 'turn.failed') {
      const message = (event.error as { message?: unknown } | undefined)?.message
      error = typeof message === 'string' ? message : 'turn failed'
    } else if (event.type === 'error') {
      error = typeof event.message === 'string' ? event.message : 'codex error'
    }
  }

  if (!sawEvent) return null
  if (!completed && !error) error = 'codex stream ended before turn.completed'
  return { result, isError: error !== undefined, error, usage: parseUsage(output), ...(threadId ? { threadId } : {}) }
}

/**
 * Codex CLI headless: `codex exec --json "<prompt>"` (model/reasoning come from
 * ~/.codex/config.toml).
 *
 * `--json` for the same reason claude-code uses stream-json: every item event
 * is a line on stdout, so the stall timer measures live activity, and the
 * final turn reports a real usage breakdown instead of a one-line footer.
 * Note codex refuses to run outside a git repository unless
 * `args: ['--skip-git-repo-check']` is passed.
 */
/** A personal server as `codex mcp list --json` reports it: the name and how it is reached. */
export interface CodexListedServer {
  name: string
  transport?: { type?: string; command?: unknown; url?: unknown }
}

/**
 * One override that switches the personal servers off. Codex validates every `mcp_servers` entry for
 * a transport, disabled or not, and a server that comes from a plugin (`[plugins."x".mcp_servers.y]`)
 * has no top-level entry to merge into — `y={enabled=false}` alone becomes a server without a
 * transport and Codex refuses to start ("invalid transport in mcp_servers.y"). So each entry repeats
 * the server's own transport: its url or its command. Disabled, it is never started; the top-level
 * entry overrides the plugin one, which `codex mcp list` then reports as disabled.
 */
export function disableServersArg(servers: CodexListedServer[]): string[] {
  if (!servers.length) return []
  const entries = servers.map((s) => {
    const t = s.transport ?? {}
    const transport = typeof t.url === 'string'
      ? `url=${JSON.stringify(t.url)}`
      : `command=${JSON.stringify(typeof t.command === 'string' ? t.command : 'true')}`
    return `${JSON.stringify(s.name)}={${transport},enabled=false}`
  })
  return ['-c', `mcp_servers={${entries.join(',')}}`]
}

/** The command line for one step: MCP servers go in as inline config overrides. */
export function codexArgs(input: ExecuteInput, disabledServers: CodexListedServer[] = []): string[] {
  return [
    'exec',
    '--json',
    ...(input.spec.model ? ['--model', input.spec.model] : []),
    ...(input.spec.args ?? []),
    ...disableServersArg(disabledServers),
    ...codexMcpArgs(input.mcp ?? []),
    '--',
    withOutputInstruction(input.prompt ?? '', input.output)
  ]
}

/**
 * Flags of `codex exec` that widen or set what the agent may touch. An output
 * repair drops them from the step's args and runs `--sandbox read-only`
 * instead; `-s`/`--sandbox` take a value.
 */
const CODEX_ACCESS_FLAGS = ['--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--yolo']
const CODEX_SANDBOX_FLAGS = ['-s', '--sandbox']

/** The step's args without its sandbox and approval choices — a repair sets its own, read-only. */
export function withoutAccessFlags(args: string[] = []): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (CODEX_ACCESS_FLAGS.includes(arg)) continue
    if (CODEX_SANDBOX_FLAGS.includes(arg)) { i++; continue }
    if (/^--sandbox=/.test(arg) || /^-s[^-]/.test(arg)) continue
    out.push(arg)
  }
  return out
}

/**
 * The command line of an output repair: the step's model and (access-free)
 * args, `--sandbox read-only`, every personal MCP server off and no contract
 * servers, then `resume <thread id>` when the step's thread is known. The
 * exec options go before the `resume` subcommand. The prompt is flora's
 * repair message, which never starts with a dash.
 */
export function codexRepairArgs(input: RepairInput, disabledServers: CodexListedServer[] = []): string[] {
  const resume = input.sessionId && SESSION_ID.test(input.sessionId) ? ['resume', input.sessionId] : []
  return [
    'exec',
    '--json',
    ...(input.spec.model ? ['--model', input.spec.model] : []),
    ...withoutAccessFlags(input.spec.args),
    '--sandbox',
    'read-only',
    ...disableServersArg(disabledServers),
    ...(resume.length ? resume : ['--']),
    input.prompt ?? ''
  ]
}

/**
 * Codex merges mcp_servers tables: `-c mcp_servers={}` does NOT remove personal servers.
 * Enumerate effective config in the actual cwd, disable each existing server, and mount
 * contract servers under fresh names so no personal env/args can merge into them.
 */
async function runCodex(input: RepairInput, args: (personal: CodexListedServer[]) => string[]): Promise<Evidence> {
  const started = Date.now()
  const discovery = await runCommand('codex', ['mcp', 'list', '--json'], {
    ...input, onOutput: undefined, timeoutMin: Math.min(input.spec.timeout_min || 0.5, 0.5), stallMin: Math.min(input.spec.stall_min || 0.5, 0.5)
  })
  if (discovery.exitCode !== 0) return { ...discovery, output: `Cannot isolate Codex MCP servers: ${discovery.output}` }
  let personal: CodexListedServer[]
  try {
    const servers: unknown = JSON.parse(discovery.output)
    if (!Array.isArray(servers) || !servers.every((s) => s && typeof s.name === 'string')) throw new Error('expected a server list')
    personal = servers as CodexListedServer[]
  } catch { return { output: 'Cannot isolate Codex MCP servers: codex mcp list --json returned an invalid list; update Codex CLI', exitCode: 1, durationMs: Date.now() - started } }
  const remaining = input.spec.timeout_min === 0 ? 0 : (input.spec.timeout_min ?? 15) - (Date.now() - started) / 60_000
  if (remaining < 0) return { output: 'Codex startup exceeded the wall-clock limit', exitCode: 137, timedOut: true, durationMs: Date.now() - started }
  const evidence = await runCommand('codex', args(personal), {
    ...input,
    timeoutMin: remaining,
    stallMin: input.spec.stall_min
  })
  evidence.durationMs = Date.now() - started

  const summary = parseCodexStream(evidence.output)
  if (!summary) {
    // Plain-text output: keep it, and take whatever usage the footer offers.
    return attachUsage(evidence)
  }
  return {
    ...evidence,
    output: summary.result ?? summary.error ?? evidence.output,
    usage: summary.usage,
    ...(summary.threadId ? { sessionId: summary.threadId } : {}),
    exitCode: summary.isError && evidence.exitCode === 0 ? 1 : evidence.exitCode
  }
}

export const codexAdapter: HarnessAdapter = {
  name: 'codex',
  execute(input): Promise<Evidence> {
    const prefix = `flora_${randomUUID().replace(/-/g, '')}_`
    return runCodex(input, (personal) => codexArgs({ ...input, mcp: input.mcp?.map((s) => ({ ...s, name: prefix + s.name })) }, personal))
  },
  repair(input): Promise<Evidence> {
    return runCodex(input, (personal) => codexRepairArgs(input, personal))
  }
}
