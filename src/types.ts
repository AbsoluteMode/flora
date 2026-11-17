/** A workflow is a named, versioned execution contract: steps, executors, verification. */
export interface WorkflowSpec {
  name: string
  version?: number
  /** One line on what the workflow does — shown when a bundle is inspected. */
  description?: string
  /** Input parameters; values substitute {{param}} placeholders in prompts and commands. */
  params?: Record<string, { required?: boolean; default?: string; description?: string }>
  steps: StepSpec[]
  /** Triggers for `flora watch`: a schedule and/or polled event sources. */
  on?: TriggerSpec
  /** Default output repair for every agent step that does not set its own. */
  output_repair?: OutputRepairSpec
}

/**
 * Output repair: when an agent's answer breaks the step's JSON output
 * contract (not JSON, no block, empty, or not matching the schema), flora
 * asks the same agent — in the same session when the harness can resume
 * it — to return the same result in the required form, read-only, instead
 * of failing the step at once.
 */
export interface OutputRepairSpec {
  /** How many repair requests before the step fails (default 2). 0 turns repair off. */
  attempts?: number
  /** Wall-clock ceiling of one repair request in minutes (default 5, capped by executor.timeout_min). 0: only the executor's limit applies. */
  timeout_min?: number
}

export interface TriggerSpec {
  /** Five-field cron expression, local time. */
  cron?: string
  sentry?: SentrySource
  command?: CommandSource
}

export interface SentrySource {
  org: string
  project: string
  /** Sentry issue search, e.g. `is:unresolved`. */
  query?: string
  /** Regular expression an issue's title or culprit must match. */
  match?: string
  interval_sec?: number
  /** API host for self-hosted installs; default https://sentry.io. */
  url?: string
}

export interface CommandSource {
  /** Shell command; a JSON object per stdout line is one event each, plain text is one event, silence is none. */
  run: string
  interval_sec?: number
  timeout_min?: number
}

export interface StepSpec {
  id: string
  title?: string
  /**
   * Steps this one waits for (ids declared earlier in the file). Without it a
   * step waits for the step right above it — the plain sequential contract.
   * Steps whose needs are met run at the same time, up to FLORA_MAX_PARALLEL.
   */
  needs?: string[]
  /**
   * Run only if this holds after substitution: `A == B`, `A != B`, `A`
   * (truthy) or `!A`. Otherwise the step is skipped and its dependants go on.
   */
  when?: string
  /** Who runs the step. Exactly one of `executor` and `parallel`. */
  executor?: ExecutorSpec
  /** Fan-out: independent branches run at once, a policy decides whether the step passed. */
  parallel?: ParallelSpec
  /** Task text handed to the harness (placeholders substituted). */
  prompt?: string
  /** For the `command` executor: the shell command to run instead of a prompt. */
  run?: string
  /** Verification contract — the step passes only when every check passes. */
  verify?: CheckSpec[]
  /**
   * Where the checks run. `cwd` (default): the run directory, as the executor
   * left it. `worktree`: a fresh detached worktree of HEAD — only what the
   * executor committed can pass; uncommitted or ignored files do not count.
   */
  verify_in?: 'cwd' | 'worktree'
  /** Output contract: what the step must hand to the steps after it. */
  output?: OutputSpec
  on_fail?: { retry?: number }
  /** Output repair for this step (a parallel step: for its branches); overrides the workflow's. */
  output_repair?: OutputRepairSpec
  /** Tools mounted into the harness for this step — nothing beyond this list. */
  tools?: ToolSpec[]
}

export interface ParallelSpec {
  /** `all` (default), `any`, or `quorum:N` — how many branches must pass. */
  require?: string
  /**
   * `worktree` (default): each branch works in its own git worktree of HEAD and
   * hands back a patch. `shared`: every branch in the run directory — for
   * read-only work, or a directory that is not a repository.
   */
  isolation?: 'worktree' | 'shared'
  branches: BranchSpec[]
}

/** A branch is a step without an id (it gets `<step>[i]`), retries or nesting. */
export interface BranchSpec {
  title?: string
  executor: ExecutorSpec
  prompt?: string
  run?: string
  verify?: CheckSpec[]
  output?: OutputSpec
  /** Output repair for this branch; overrides the parallel step's and the workflow's. */
  output_repair?: OutputRepairSpec
  tools?: ToolSpec[]
}

/**
 * One tool source for a step: an external MCP server the harness starts, or a
 * flora-native tool served by `flora mcp` with this run's context.
 */
export type ToolSpec =
  | { mcp: { name: string; command: string; args?: string[]; env?: Record<string, string> } }
  | { flora: 'call_workflow'; workflow: string }
  | { flora: 'read_context' }

export interface OutputSpec {
  /** json: the output is parsed (and validated); text: kept as is. Default text. */
  type?: 'json' | 'text'
  /** JSON Schema the parsed value must satisfy. */
  schema?: Record<string, unknown>
}

export interface ExecutorSpec {
  /** Which adapter executes this step: claude-code | codex | antigravity | harmonia | command | api. */
  harness: string
  model?: string
  /** `api` harness: the provider's name in ~/.flora/providers.yaml — where the request goes and which env var holds the key. */
  provider?: string
  /** `api` harness: sampling temperature passed through. */
  temperature?: number
  /** `api` harness: completion length cap passed through. */
  max_tokens?: number
  /** Wall-clock ceiling in minutes (default 15). 0 disables. */
  timeout_min?: number
  /**
   * Silence ceiling in minutes (default 5): no stdout/stderr for this long and
   * the step is declared stalled and its whole process tree killed. 0 disables.
   * Distinct from timeout_min — a hang and a runaway are different diseases.
   */
  stall_min?: number
  /** Extra CLI args passed through to the harness. */
  args?: string[]
  /** `antigravity` harness: reasoning level, appended to the model id (`gemini-4-carbon` + `high` → `gemini-4-carbon-high`). */
  reasoning?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** `antigravity` harness: `read` (default) may only read the run directory; `write` may edit it. */
  access?: 'read' | 'write'
}

export interface CheckSpec {
  type: 'command' | 'artifact'
  /** command: shell command; must exit 0 (or expect_exit) to pass. */
  run?: string
  expect_exit?: number
  /** command: substring that must appear in the check's output. */
  expect_match?: string
  /** artifact: path that must exist (relative to the run cwd). */
  path?: string
  /** artifact: substring that must appear in the file. */
  contains?: string
}

/** Token accounting a harness reported for one attempt; every field optional. */
export interface Usage {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  /** Prompt-side total (input + cache) — the number that grows as context does. */
  contextTokens?: number
  /** Reported total, or context + output when the harness gave a breakdown. */
  totalTokens?: number
  /** Percent of the subscription limit consumed, when the harness says. */
  limitPct?: number
  /** Model calls the step made, when the tool counts them (a script fanning out over an API). */
  calls?: number
  /** Money, when the tool reports it (Claude Code's total_cost_usd, OpenRouter's usage.cost, a script's cost_usd). */
  costUsd?: number
}

/** A retried step keeps a light record of each earlier attempt: its tokens and money were spent too. */
export interface PriorAttempt {
  attempt: number
  status: StepStatus
  evidence?: Pick<Evidence, 'durationMs' | 'exitCode' | 'costUsd' | 'usage' | 'stalled' | 'timedOut'>
}

/** What an executor hands back; the verifier judges the state it left behind. */
export interface Evidence {
  output: string
  exitCode: number | null
  durationMs: number
  costUsd?: number
  usage?: Usage
  /** Killed for going silent longer than stall_min. */
  stalled?: boolean
  /** Killed at the timeout_min wall-clock limit. */
  timedOut?: boolean
  /** The harness's own conversation/session id, when it reports one (Claude Code, Codex, Antigravity) — to resume or look it up there. */
  sessionId?: string
}

/** One problem the output contract found: a JSON pointer into the value (`/changes`; empty for the whole answer) and what is wrong there. */
export interface OutputIssue {
  path: string
  message: string
}

/**
 * One output repair request of a step attempt, as journaled on the step.
 * Its time, tokens and money are already folded into the step's `evidence`;
 * these are the per-request figures.
 */
export interface OutputRepair {
  /** 1-based number of the repair within this step attempt. */
  repair: number
  /** `resume`: the agent's own session was continued; `fresh`: a new short request with the invalid answer quoted. */
  mode: 'resume' | 'fresh'
  /** What was wrong with the answer this request had to fix, as one line. */
  error: string
  /** The same, per problem. */
  errors: OutputIssue[]
  status: 'passed' | 'failed'
  durationMs: number
  exitCode: number | null
  /** Why the answer to this request still did not pass (or why the request itself failed). */
  resultError?: string
  costUsd?: number
  usage?: Usage
  sessionId?: string
  stalled?: boolean
  timedOut?: boolean
  /** The message flora sent. */
  prompt?: string
  /** The agent's answer (capped). */
  output?: string
}

export interface CheckResult {
  check: CheckSpec
  passed: boolean
  detail: string
}

export type StepStatus = 'pending' | 'running' | 'verifying' | 'passed' | 'failed' | 'skipped'

export interface StepResult {
  stepId: string
  title?: string
  /** Which harness executed this attempt — the journal has to stand on its own. */
  harness?: string
  attempt: number
  status: StepStatus
  evidence?: Evidence
  checks: CheckResult[]
  /** The value the step produced under its output contract. */
  output?: unknown
  /** Why the output contract was not met, when it was not. */
  outputError?: string
  /** Why the step failed when neither a check nor the output contract says so (e.g. a parallel policy). */
  error?: string
  /** The `when` condition that did not hold, for a skipped step. */
  skipReason?: string
  /** Set when the checks ran in a worktree of HEAD rather than the run directory. */
  verifiedIn?: 'worktree'
  /** Parallel step: one result per branch, in branch order. */
  branches?: StepResult[]
  /** Parallel step: each passed branch's output (or printed text), null for a failed one. */
  outputs?: unknown[]
  /** Parallel step: path of each branch's patch against HEAD, null when it changed nothing or ran shared. */
  patches?: Array<string | null>
  /** Earlier attempts of a retried step, oldest first — `flora usage` counts them. */
  priorAttempts?: PriorAttempt[]
  /** Steps this one draws on: `needs` plus every `{{steps.<id>…}}` it references. The run's data flow. */
  inputsFrom?: string[]
  /** Numbers the step reported about its own work — `metrics` in its JSON output (`in`, `out`, anything countable). */
  metrics?: Record<string, number>
  /** Size of the value the step produced under its output contract. */
  outputBytes?: number
  /** What was actually sent: the prompt after parameter substitution (agent steps). */
  prompt?: string
  /** What was actually run: the command after parameter substitution (command steps). */
  command?: string
  /** Files the step declared in its output (`artifacts: [...]`), copied into the run's artifact directory. */
  artifacts?: StepArtifact[]
  /** Output repair requests of this attempt, oldest first — only when the first answer broke the output contract. */
  outputRepairs?: OutputRepair[]
}

export interface StepArtifact {
  /** Path inside the run's artifact directory: `<stepId>/<name>`. */
  path: string
  /** Where the step wrote it (relative to the run cwd when it was). */
  source: string
  bytes: number
}

export interface RunRecord {
  runId: string
  workflow: string
  cwd: string
  params: Record<string, string>
  /** `interrupted`: the flora process died mid-run (killed, crashed, machine off) — the journal never got a run_end. */
  status: 'running' | 'passed' | 'failed' | 'error' | 'interrupted'
  startedAt: string
  finishedAt?: string
  steps: StepResult[]
  /** Set when this run was started by a step of another run (call_workflow). */
  parentRunId?: string
  /** Set when `flora watch` started this run: the source and the event's fingerprint. */
  trigger?: { source: string; id: string }
}

/** Row shape for run listings — the journal index without the heavy step payload. */
export type RunSummary = Pick<
  RunRecord,
  'runId' | 'workflow' | 'status' | 'startedAt' | 'finishedAt'
> & {
  /** Last sign of life from the recording process; a running run without a recent one is interrupted. */
  heartbeatAt?: string
}

export interface RunEvent {
  type:
    | 'run_start'
    | 'step_start'
    | 'executor_output'
    | 'step_verifying'
    | 'check_result'
    | 'step_result'
    | 'step_skipped'
    | 'branch_start'
    | 'branch_result'
    | 'output_repair_start'
    | 'output_repair_result'
    | 'run_end'
  [key: string]: unknown
}

export type RunEventHandler = (event: RunEvent) => void
