import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Evidence, ExecutorSpec, Usage } from '../types'
import { SESSION_ID, type ExecuteInput, type HarnessAdapter, type RepairInput } from './types'
import { runCommand } from './command'
import { withOutputInstruction } from '../output'

/** The family a step runs on when it names no model. */
export const ANTIGRAVITY_DEFAULT_FAMILY = 'gemini-4-carbon'
/** The reasoning level a step gets when it names neither a level nor a full model id. */
export const ANTIGRAVITY_DEFAULT_REASONING = 'medium'
/** Levels agy spells as the last part of a model id: `gemini-4-carbon-high`. */
export const ANTIGRAVITY_REASONING = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Flags the adapter owns. A step cannot pass them through `args`: they decide
 * what the agent may touch (`--mode`, `--settings`, the permission bypass) or
 * how flora reads the answer (`--print`, `--output-format`, `--model`).
 */
export const ANTIGRAVITY_OWNED_FLAGS = [
  'dangerously-skip-permissions', 'mode', 'settings', 'sandbox', 'model', 'effort',
  'print', 'p', 'prompt', 'prompt-interactive', 'i', 'output-format', 'input-format', 'conversation'
]

/** The owned flag an `args` list tries to set, if any (`--mode`, `-mode`, `--mode=auto` alike). */
export function ownedAntigravityFlag(args: string[] = []): string | undefined {
  for (const arg of args) {
    const name = /^--?([A-Za-z][\w-]*)(?:=|$)/.exec(arg)?.[1]
    if (name && ANTIGRAVITY_OWNED_FLAGS.includes(name)) return arg
  }
  return undefined
}

/**
 * Per-session settings (`--settings`, never saved to agy's own settings.json).
 * Both kinds keep commands in the terminal sandbox, outside the workspace
 * closed, and every MCP server off — flora mounts no tools into agy, so the
 * agent's personal servers stay out of the step, as they do for Codex.
 */
export const ANTIGRAVITY_SETTINGS = {
  write: {
    agentMode: 'auto',
    toolPermission: 'request-review',
    enableTerminalSandbox: true,
    allowNonWorkspaceAccess: false,
    permissions: { deny: ['mcp(*)'] }
  },
  read: {
    agentMode: '',
    toolPermission: 'request-review',
    enableTerminalSandbox: true,
    allowNonWorkspaceAccess: false,
    permissions: {
      deny: ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'mcp(*)']
    }
  }
} as const

/** Ids from `agy models`: `<id>\t<name>` per line; the "Fetching…" banner and blank lines are skipped. */
export function parseAntigravityModels(output: string): string[] {
  const ids: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const id = /^([A-Za-z0-9][\w.-]*)\t/.exec(line)?.[1]
    if (id) ids.push(id)
  }
  return ids
}

export type ModelChoice = { ok: true; model: string } | { ok: false; error: string }

/**
 * The agy model id for a step. agy has no reasoning flag of its own in print
 * mode worth relying on — the level is the last part of the id — so
 * `model: gemini-4-carbon` + `reasoning: high` becomes `gemini-4-carbon-high`.
 * A full id (`gemini-4-carbon-low`) is taken as is; a family alone gets the
 * default level. The result must be one `agy models` lists.
 */
export function antigravityModel(spec: Pick<ExecutorSpec, 'model' | 'reasoning'>, listed: string[]): ModelChoice {
  const model = spec.model?.trim() || ANTIGRAVITY_DEFAULT_FAMILY
  const suffix = new RegExp(`-(${ANTIGRAVITY_REASONING.join('|')})$`)
  let id: string
  if (spec.reasoning) {
    if (suffix.test(model)) {
      return { ok: false, error: `antigravity: model "${model}" already names a reasoning level — drop executor.reasoning or name the family ("${model.replace(suffix, '')}")` }
    }
    id = `${model}-${spec.reasoning}`
  } else {
    id = listed.includes(model) ? model : `${model}-${ANTIGRAVITY_DEFAULT_REASONING}`
  }
  if (listed.includes(id)) return { ok: true, model: id }
  const family = model.replace(suffix, '')
  const near = listed.filter((m) => m.startsWith(family))
  return {
    ok: false,
    error: `antigravity: model "${id}" is not offered by \`agy models\` (${near.length ? `${family}: ${near.join(', ')}` : `available: ${listed.join(', ') || 'none'}`})`
  }
}

/**
 * Where agy is: on PATH, or in ~/.local/bin, where its installer puts it and
 * which a non-login shell (launchd, an IDE) often does not have on PATH. On
 * Windows the same names as a shell would try: agy.exe, then an npm shim
 * agy.cmd — runCommand starts the .exe directly and unwraps the shim to run
 * its JavaScript with our node, so the JSON settings and a multi-line prompt
 * never pass through cmd.exe (the route Codex takes as well).
 */
export function findAgy(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env[Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'] ?? ''
  const names = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy']
  const dirs = [...pathValue.split(delimiter), join(env.HOME || homedir(), '.local', 'bin')]
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name)
  }
  return null
}

export const AGY_NOT_INSTALLED = 'agy is not installed: not on PATH and not in ~/.local/bin — install the Antigravity CLI, then run `flora doctor`'

/** The command line for one step, once the model id is settled. The prompt goes last, after `--print`. */
export function antigravityArgs(input: ExecuteInput, model: string): string[] {
  const access = input.spec.access ?? 'read'
  return [
    '--output-format',
    'stream-json',
    '--disable-slash-commands',
    '--model',
    model,
    '--sandbox',
    // Read-only has no --mode at all: `--mode plan` in print mode approves its own plan and may then edit.
    ...(access === 'write' ? ['--mode', 'auto'] : []),
    '--settings',
    JSON.stringify(ANTIGRAVITY_SETTINGS[access]),
    ...(input.spec.args ?? []),
    '--print',
    withOutputInstruction(input.prompt ?? '', input.output)
  ]
}

/**
 * The command line of an output repair: always the read-only settings (no
 * `--mode`), whatever the step's access — repair changes the form of an
 * answer, never files — and `--conversation <id>` when the step's
 * conversation is known. The prompt is flora's repair message, sent as is.
 */
export function antigravityRepairArgs(input: RepairInput, model: string): string[] {
  return [
    '--output-format',
    'stream-json',
    '--disable-slash-commands',
    '--model',
    model,
    '--sandbox',
    '--settings',
    JSON.stringify(ANTIGRAVITY_SETTINGS.read),
    ...(input.spec.args ?? []),
    ...(input.sessionId && SESSION_ID.test(input.sessionId) ? ['--conversation', input.sessionId] : []),
    '--print',
    input.prompt ?? ''
  ]
}

export interface AntigravityStreamSummary {
  result?: string
  isError: boolean
  error?: string
  /** agy's conversation id — `--conversation <id>` resumes it. */
  conversationId?: string
  /** The model agy says it started with (the `init` frame). */
  model?: string
  usage?: Usage
}

type Frame = Record<string, unknown>
const asFrame = (value: unknown): Frame | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Frame) : undefined
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/**
 * Read a `--output-format stream-json` transcript (agy 1.5.9), one frame per line:
 *
 *   {"event":"init","conversation_id":"…","init":{"model":"gemini-4-carbon-low","cwd":"…",…}}
 *   {"event":"step_update","step_update":{"conversation_id":"…","step_type":"tool",…}}
 *   {"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…","usage":{…}}}
 *
 * The answer is `result.response`; a status other than SUCCESS, an `error`
 * frame, or a stream without a result is a failed turn. Lines that are not
 * JSON are skipped. Returns null when there is no frame at all (a crash
 * before the stream, a refusal printed as plain text).
 */
export function parseAntigravityStream(output: string): AntigravityStreamSummary | null {
  let sawFrame = false
  let conversationId: string | undefined
  let model: string | undefined
  let result: Frame | undefined
  let error: string | undefined
  let streamed = ''

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let frame: Frame
    try {
      frame = JSON.parse(trimmed) as Frame
    } catch {
      continue
    }
    const event = str(frame.event)
    if (!event) continue
    sawFrame = true
    const body = asFrame(frame[event])
    conversationId ??= str(frame.conversation_id) ?? str(body?.conversation_id)
    if (event === 'init') model ??= str(body?.model)
    else if (event === 'result') result = body ?? {}
    else if (event === 'error') error = str(frame.message) ?? str(body?.message) ?? str(frame.error) ?? 'antigravity error'
    else if (event === 'step_update' && typeof body?.text_delta === 'string') streamed += body.text_delta
  }

  if (!sawFrame) return null
  if (!result) {
    return { result: streamed || undefined, isError: true, error: error ?? 'antigravity stream ended without a result', conversationId, model }
  }
  const status = str(result.status)
  const isError = (status !== undefined && status !== 'SUCCESS') || error !== undefined
  return {
    result: str(result.response) ?? (streamed || undefined),
    isError,
    error: isError ? (error ?? str(result.error) ?? str(result.message) ?? `antigravity turn ended with status ${status}`) : undefined,
    conversationId,
    model,
    usage: antigravityUsage(asFrame(result.usage))
  }
}

/**
 * agy's usage: `cache_read_tokens` sits apart from `input_tokens` (input
 * shrinks as the cache grows across a turn), and `total_tokens` is input +
 * output. The context is input plus the cache reads.
 */
function antigravityUsage(raw: Frame | undefined): Usage | undefined {
  if (!raw) return undefined
  const n = (key: string): number | undefined => (typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined)
  const usage: Usage = {}
  const input = n('input_tokens')
  const cached = n('cache_read_tokens')
  if (input !== undefined) usage.inputTokens = input
  if (n('output_tokens') !== undefined) usage.outputTokens = n('output_tokens')
  if (cached) usage.cachedTokens = cached
  if (input !== undefined) usage.contextTokens = input + (cached ?? 0)
  if (n('total_tokens') !== undefined) usage.totalTokens = n('total_tokens')
  return Object.keys(usage).length ? usage : undefined
}

/**
 * Antigravity headless: `agy --output-format stream-json --model <id> --sandbox
 * [--mode auto] --settings <json> --print "<prompt>"`, in the run directory.
 *
 * `executor.access` decides what the agent may do: `read` (the default) keeps
 * commands, file writes, the network and MCP denied; `write` lets it edit the
 * workspace in auto mode with commands in the terminal sandbox. Never
 * `--dangerously-skip-permissions`. Before the run, `agy models` settles the
 * model id, so a model the account does not offer fails before any work.
 */
async function runAgy(input: RepairInput & Pick<ExecuteInput, 'mcp'>, args: (model: string) => string[]): Promise<Evidence> {
  const started = Date.now()
  const owned = ownedAntigravityFlag(input.spec.args)
  if (owned) return { output: `antigravity: executor.args cannot set ${owned} — flora owns that flag`, exitCode: 1, durationMs: 0 }
  if (input.mcp?.length) return { output: 'antigravity: this harness cannot mount tools — flora has no per-step MCP route into agy', exitCode: 1, durationMs: 0 }
  const agy = findAgy({ ...process.env, ...input.env })
  if (!agy) return { output: AGY_NOT_INSTALLED, exitCode: null, durationMs: 0 }

  const listing = await runCommand(agy, ['models'], {
    ...input, onOutput: undefined, timeoutMin: Math.min(input.spec.timeout_min || 0.5, 0.5), stallMin: Math.min(input.spec.stall_min || 0.5, 0.5)
  })
  if (listing.exitCode !== 0) return { ...listing, output: `antigravity: \`agy models\` failed, so the model cannot be checked: ${listing.output}`, durationMs: Date.now() - started }
  const choice = antigravityModel(input.spec, parseAntigravityModels(listing.output))
  if (!choice.ok) return { output: choice.error, exitCode: 1, durationMs: Date.now() - started }

  const remaining = input.spec.timeout_min === 0 ? 0 : (input.spec.timeout_min ?? 15) - (Date.now() - started) / 60_000
  if (remaining < 0) return { output: 'Antigravity startup exceeded the wall-clock limit', exitCode: 137, timedOut: true, durationMs: Date.now() - started }
  const evidence = await runCommand(agy, args(choice.model), {
    ...input,
    timeoutMin: remaining,
    stallMin: input.spec.stall_min
  })
  evidence.durationMs = Date.now() - started

  const summary = parseAntigravityStream(evidence.output)
  if (!summary) return evidence
  const session = summary.conversationId ? { sessionId: summary.conversationId } : {}
  // A step flora killed keeps its transcript and the kill note; the id still says which conversation it was.
  if (evidence.timedOut || evidence.stalled) return { ...evidence, ...session }
  // The model is pinned: a conversation that started on another one is not the step the contract asked for.
  if (summary.model && summary.model !== choice.model) {
    return { ...evidence, ...session, output: `antigravity: agy ran ${summary.model} instead of ${choice.model}`, exitCode: 1 }
  }
  return {
    ...evidence,
    ...session,
    output: summary.isError ? (summary.error ?? evidence.output) : (summary.result ?? evidence.output),
    ...(summary.usage ? { usage: summary.usage } : {}),
    exitCode: summary.isError && evidence.exitCode === 0 ? 1 : evidence.exitCode
  }
}

export const antigravityAdapter: HarnessAdapter = {
  name: 'antigravity',
  execute(input): Promise<Evidence> {
    return runAgy(input, (model) => antigravityArgs(input, model))
  },
  repair(input): Promise<Evidence> {
    return runAgy(input, (model) => antigravityRepairArgs(input, model))
  }
}
