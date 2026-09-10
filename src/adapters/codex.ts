import type { Evidence, Usage } from '../types'
import type { HarnessAdapter } from './types'
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

    if (event.type === 'item.completed') {
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
  return { result, isError: error !== undefined, error, usage: parseUsage(output) }
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
/** The command line for one step: MCP servers go in as inline config overrides. */
export function codexArgs(input: ExecuteInput, disabledServers: string[] = []): string[] {
  return [
    'exec',
    '--json',
    ...(input.spec.model ? ['--model', input.spec.model] : []),
    ...(input.spec.args ?? []),
    ...(disabledServers.length ? ['-c', `mcp_servers={${disabledServers.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(',')}}`] : []),
    ...codexMcpArgs(input.mcp ?? []),
    '--',
    withOutputInstruction(input.prompt ?? '', input.output)
  ]
}

export const codexAdapter: HarnessAdapter = {
  name: 'codex',
  async execute(input): Promise<Evidence> {
    // Codex merges mcp_servers tables: `-c mcp_servers={}` does NOT remove personal servers.
    // Enumerate effective config in the actual cwd, disable each existing server, and mount
    // contract servers under fresh names so no personal env/args can merge into them.
    const started = Date.now()
    const discovery = await runCommand('codex', ['mcp', 'list', '--json'], {
      ...input, onOutput: undefined, timeoutMin: Math.min(input.spec.timeout_min || 0.5, 0.5), stallMin: Math.min(input.spec.stall_min || 0.5, 0.5)
    })
    if (discovery.exitCode !== 0) return { ...discovery, output: `Cannot isolate Codex MCP servers: ${discovery.output}` }
    let names: string[]
    try {
      const servers: unknown = JSON.parse(discovery.output)
      if (!Array.isArray(servers) || !servers.every((s) => s && typeof s.name === 'string')) throw new Error('expected a server list')
      names = servers.map((s) => s.name)
    } catch { return { output: 'Cannot isolate Codex MCP servers: codex mcp list --json returned an invalid list; update Codex CLI', exitCode: 1, durationMs: Date.now() - started } }
    const prefix = `flora_${randomUUID().replace(/-/g, '')}_`
    const args = codexArgs({ ...input, mcp: input.mcp?.map((s) => ({ ...s, name: prefix + s.name })) }, names)
    const remaining = input.spec.timeout_min === 0 ? 0 : (input.spec.timeout_min ?? 15) - (Date.now() - started) / 60_000
    if (remaining < 0) return { output: 'Codex startup exceeded the wall-clock limit', exitCode: 137, timedOut: true, durationMs: Date.now() - started }
    const evidence = await runCommand('codex', args, {
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
      exitCode: summary.isError && evidence.exitCode === 0 ? 1 : evidence.exitCode
    }
  }
}
