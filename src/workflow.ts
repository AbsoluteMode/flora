import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { BranchSpec, StepSpec, WorkflowSpec } from './types'
import { referencesSteps, substituteContext, type RunContext } from './context'
import { parseCron } from './cron'
import { schemaErrors } from './contract'
import { assertOutputSchema } from './output'

export class WorkflowError extends Error {}

const KNOWN_HARNESSES = new Set(['claude-code', 'codex', 'harmonia', 'command', 'api'])

// The code validator and schema/workflow.schema.json enforce the same rules;
// a test corpus keeps them in step. Unknown fields are refused rather than
// ignored — a silently skipped `verfy:` is a contract that never verifies.
const ROOT_KEYS = new Set(['name', 'version', 'description', 'params', 'steps', 'on'])
const ON_KEYS = new Set(['cron', 'sentry', 'command'])
const SENTRY_KEYS = new Set(['org', 'project', 'query', 'match', 'interval_sec', 'url'])
const COMMAND_SOURCE_KEYS = new Set(['run', 'interval_sec', 'timeout_min'])
const PARAM_KEYS = new Set(['required', 'default', 'description'])
const STEP_KEYS = new Set(['id', 'title', 'needs', 'when', 'executor', 'parallel', 'prompt', 'run', 'verify', 'verify_in', 'output', 'on_fail', 'tools'])
const BRANCH_KEYS = new Set(['title', 'executor', 'prompt', 'run', 'verify', 'output', 'tools'])
const PARALLEL_KEYS = new Set(['require', 'isolation', 'branches'])
const EXECUTOR_KEYS = new Set(['harness', 'model', 'timeout_min', 'stall_min', 'args', 'provider', 'temperature', 'max_tokens'])
const CHECK_KEYS = new Set(['type', 'run', 'expect_exit', 'expect_match', 'path', 'contains'])
const OUTPUT_KEYS = new Set(['type', 'schema'])
const ON_FAIL_KEYS = new Set(['retry'])
const MCP_TOOL_KEYS = new Set(['name', 'command', 'args', 'env'])
/** Harnesses with an MCP client; the others get a clear refusal, not a silently dropped contract. */
const TOOL_HARNESSES = new Set(['claude-code', 'codex'])
/** Referenced as `{{steps.<id>…}}`, so an id has to be a plain identifier. */
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function rejectUnknown(where: string, value: object, known: Set<string>): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new WorkflowError(`${where}: unknown field "${key}"`)
  }
}

export function loadWorkflow(path: string): WorkflowSpec {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new WorkflowError(`cannot read workflow file: ${path}`)
  }
  const spec = parse(raw) as WorkflowSpec
  validateWorkflow(spec)
  return spec
}

export function validateWorkflow(spec: WorkflowSpec): void {
  if (!isMapping(spec)) throw new WorkflowError('workflow is not a mapping')
  rejectUnknown('workflow', spec, ROOT_KEYS)
  if (!spec.name || typeof spec.name !== 'string') throw new WorkflowError('workflow.name is required')
  if (spec.version !== undefined && !(Number.isInteger(spec.version) && spec.version >= 1)) {
    throw new WorkflowError('workflow.version must be a positive integer')
  }
  if (spec.description !== undefined && typeof spec.description !== 'string') {
    throw new WorkflowError('workflow.description must be a string')
  }
  if (spec.params !== undefined) {
    if (!isMapping(spec.params)) throw new WorkflowError('workflow.params must be a mapping')
    for (const [name, def] of Object.entries(spec.params)) {
      if (!isMapping(def)) throw new WorkflowError(`param ${name}: must be a mapping with required/default`)
      rejectUnknown(`param ${name}`, def, PARAM_KEYS)
      if (def.required !== undefined && typeof def.required !== 'boolean') {
        throw new WorkflowError(`param ${name}: required must be true or false`)
      }
      if (def.default !== undefined && typeof def.default !== 'string') {
        throw new WorkflowError(`param ${name}: default must be a string`)
      }
      if (def.description !== undefined && typeof def.description !== 'string') {
        throw new WorkflowError(`param ${name}: description must be a string`)
      }
    }
  }
  if (spec.on !== undefined) validateTriggers(spec.on)
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    throw new WorkflowError('workflow.steps must be a non-empty list')
  }

  const seen = new Set<string>()
  for (const step of spec.steps) {
    if (!isMapping(step)) throw new WorkflowError('every step must be a mapping')
    if (!step.id) throw new WorkflowError('every step needs an id')
    if (typeof step.id !== 'string' || !STEP_ID.test(step.id)) {
      throw new WorkflowError(
        `step ${String(step.id)}: id must be a plain identifier (letters, digits, _ and -) so it can be referenced as {{steps.<id>…}}`
      )
    }
    if (seen.has(step.id)) throw new WorkflowError(`duplicate step id: ${step.id}`)
    seen.add(step.id)
    const where = `step ${step.id}`
    rejectUnknown(where, step, STEP_KEYS)
    if (step.title !== undefined && typeof step.title !== 'string') {
      throw new WorkflowError(`${where}: title must be a string`)
    }
    if (step.needs !== undefined) {
      if (!Array.isArray(step.needs) || !step.needs.every((n) => typeof n === 'string')) {
        throw new WorkflowError(`${where}: needs must be a list of step ids`)
      }
      // Only ids declared above: a graph that can only point backwards has no cycles.
      for (const need of step.needs) {
        if (need === step.id) throw new WorkflowError(`${where}: needs itself`)
        if (!seen.has(need)) {
          throw new WorkflowError(`${where}: needs "${need}", which is not a step declared above it`)
        }
      }
      if (new Set(step.needs).size !== step.needs.length) throw new WorkflowError(`${where}: needs lists a step twice`)
    }
    if (step.when !== undefined && (typeof step.when !== 'string' || !step.when.trim())) {
      throw new WorkflowError(`${where}: when must be a non-empty condition string`)
    }
    if (step.on_fail !== undefined) {
      if (!isMapping(step.on_fail)) throw new WorkflowError(`${where}: on_fail must be a mapping`)
      rejectUnknown(`${where}: on_fail`, step.on_fail, ON_FAIL_KEYS)
      const retry = step.on_fail.retry
      if (retry !== undefined && !(Number.isInteger(retry) && retry >= 0)) {
        throw new WorkflowError(`${where}: on_fail.retry must be an integer >= 0`)
      }
    }

    const hasExecutor = step.executor !== undefined
    const hasParallel = step.parallel !== undefined
    if (hasExecutor === hasParallel) {
      throw new WorkflowError(`${where}: needs exactly one of "executor" (one runner) and "parallel" (branches)`)
    }
    if (step.verify_in !== undefined && step.verify_in !== 'cwd' && step.verify_in !== 'worktree') {
      throw new WorkflowError(`${where}: verify_in must be cwd or worktree`)
    }
    if (hasParallel) {
      for (const key of ['prompt', 'run', 'verify', 'output', 'tools'] as const) {
        if (step[key] !== undefined) {
          throw new WorkflowError(`${where}: with "parallel", ${key} belongs on the branches, not on the step`)
        }
      }
      if (step.verify_in !== undefined) {
        throw new WorkflowError(`${where}: verify_in does not apply to a parallel step — branches already verify in their own worktrees`)
      }
      validateParallel(where, step.parallel)
    } else {
      validateBody(where, step as BranchSpec)
    }
  }
  const shapeErrors = schemaErrors(spec)
  if (shapeErrors.length) throw new WorkflowError(shapeErrors.map((e) => `${e.path}: ${e.message}`).join('; '))
}

/** The runnable part shared by a step and a branch: executor, prompt/run, checks, output, tools. */
function validateBody(where: string, body: BranchSpec): void {
  if (!isMapping(body.executor) || !body.executor.harness) {
    throw new WorkflowError(`${where}: executor.harness is required`)
  }
  rejectUnknown(`${where}: executor`, body.executor, EXECUTOR_KEYS)
  const harness = body.executor.harness
  if (!KNOWN_HARNESSES.has(harness)) {
    throw new WorkflowError(`${where}: unknown harness "${harness}" (known: ${[...KNOWN_HARNESSES].join(', ')})`)
  }
  if (body.executor.model !== undefined && typeof body.executor.model !== 'string') {
    throw new WorkflowError(`${where}: executor.model must be a string`)
  }
  if (
    body.executor.args !== undefined &&
    !(Array.isArray(body.executor.args) && body.executor.args.every((arg) => typeof arg === 'string'))
  ) {
    throw new WorkflowError(`${where}: executor.args must be a list of strings`)
  }
  for (const key of ['timeout_min', 'stall_min'] as const) {
    const value = body.executor[key]
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      throw new WorkflowError(`${where}: executor.${key} must be a number of minutes >= 0`)
    }
  }
  // The api harness: a model API named by provider, configured on the machine, never in the file.
  if (harness === 'api' && (typeof body.executor.provider !== 'string' || !body.executor.provider)) {
    throw new WorkflowError(`${where}: the api harness needs executor.provider — a name from ~/.flora/providers.yaml`)
  }
  if (harness !== 'api') {
    for (const key of ['provider', 'temperature', 'max_tokens'] as const) {
      if (body.executor[key] !== undefined) throw new WorkflowError(`${where}: executor.${key} only applies to the api harness`)
    }
  }
  if (body.executor.temperature !== undefined && !(typeof body.executor.temperature === 'number' && body.executor.temperature >= 0 && body.executor.temperature <= 2)) {
    throw new WorkflowError(`${where}: executor.temperature must be a number between 0 and 2`)
  }
  if (body.executor.max_tokens !== undefined && !(Number.isInteger(body.executor.max_tokens) && body.executor.max_tokens > 0)) {
    throw new WorkflowError(`${where}: executor.max_tokens must be a positive integer`)
  }
  if (body.tools !== undefined) validateTools(where, harness, body.tools as unknown[])
  if (harness === 'command' && !body.run) {
    throw new WorkflowError(`${where}: the command executor needs "run"`)
  }
  if (harness !== 'command' && !body.prompt) {
    throw new WorkflowError(`${where}: harness executors need a "prompt"`)
  }
  // Step outputs and trigger events are data a harness or the outside world
  // produced. Interpolating them into a shell line is an injection waiting
  // to happen, so shell steps read them from the $FLORA_CONTEXT file instead.
  if (referencesSteps(body.run)) {
    throw new WorkflowError(
      `${where}: {{steps.*}} and {{event.*}} are not allowed in "run" — read the JSON file at $FLORA_CONTEXT instead`
    )
  }
  if (body.output !== undefined) {
    if (!isMapping(body.output)) throw new WorkflowError(`${where}: output must be a mapping with type/schema`)
    rejectUnknown(`${where}: output`, body.output, OUTPUT_KEYS)
    if (body.output.type !== undefined && body.output.type !== 'json' && body.output.type !== 'text') {
      throw new WorkflowError(`${where}: output.type must be json or text`)
    }
    if (body.output.schema !== undefined && !isMapping(body.output.schema)) {
      throw new WorkflowError(`${where}: output.schema must be a JSON Schema object`)
    }
    if (body.output.schema && (body.output.type ?? 'text') !== 'json') {
      throw new WorkflowError(`${where}: output.schema needs output.type: json`)
    }
    if (body.output.schema) {
      try { assertOutputSchema(body.output.schema) }
      catch (err) { throw new WorkflowError(`${where}: invalid output.schema: ${(err as Error).message}`) }
    }
  }
  if (body.verify !== undefined && !Array.isArray(body.verify)) {
    throw new WorkflowError(`${where}: verify must be a list of checks`)
  }
  for (const check of body.verify ?? []) {
    if (!isMapping(check)) throw new WorkflowError(`${where}: every check must be a mapping`)
    rejectUnknown(`${where}: check`, check, CHECK_KEYS)
    if (check.type !== 'command' && check.type !== 'artifact') {
      throw new WorkflowError(`${where}: check type must be command or artifact`)
    }
    if (check.expect_exit !== undefined && !Number.isInteger(check.expect_exit)) {
      throw new WorkflowError(`${where}: expect_exit must be an integer`)
    }
    if (check.type === 'command' && !check.run) throw new WorkflowError(`${where}: command check needs "run"`)
    if (check.type === 'artifact' && !check.path) throw new WorkflowError(`${where}: artifact check needs "path"`)
    if (referencesSteps(check.run)) {
      throw new WorkflowError(
        `${where}: {{steps.*}} and {{event.*}} are not allowed in a check's "run" — read $FLORA_CONTEXT instead`
      )
    }
  }
}

/** `all` | `any` | `quorum:N` — how many of `count` branches a parallel step needs. */
export function parseRequire(require: string | undefined, count: number): { kind: 'all' | 'any' | 'quorum'; n: number } {
  if (require === undefined || require === 'all') return { kind: 'all', n: count }
  if (require === 'any') return { kind: 'any', n: 1 }
  const match = /^quorum:(\d+)$/.exec(String(require))
  if (!match) throw new WorkflowError(`parallel.require must be all, any or quorum:N (got "${String(require)}")`)
  const n = Number(match[1])
  if (n < 1 || n > count) throw new WorkflowError(`parallel.require quorum:${n} is impossible with ${count} branches`)
  return { kind: 'quorum', n }
}

function validateParallel(where: string, parallel: unknown): void {
  if (!isMapping(parallel)) throw new WorkflowError(`${where}: parallel must be a mapping with branches`)
  rejectUnknown(`${where}: parallel`, parallel, PARALLEL_KEYS)
  const branches = parallel.branches
  if (!Array.isArray(branches) || !branches.length) {
    throw new WorkflowError(`${where}: parallel.branches must be a non-empty list`)
  }
  if (parallel.isolation !== undefined && parallel.isolation !== 'worktree' && parallel.isolation !== 'shared') {
    throw new WorkflowError(`${where}: parallel.isolation must be worktree or shared`)
  }
  try {
    parseRequire(parallel.require as string | undefined, branches.length)
  } catch (err) {
    throw new WorkflowError(`${where}: ${(err as Error).message}`)
  }
  branches.forEach((branch, i) => {
    const at = `${where}[${i}]`
    if (!isMapping(branch)) throw new WorkflowError(`${at}: a branch must be a mapping`)
    rejectUnknown(at, branch, BRANCH_KEYS)
    validateBody(at, branch as unknown as BranchSpec)
  })
}

/** `on:` — a cron expression that parses now, not at 09:00 on Monday, and well-formed sources. */
function validateTriggers(on: unknown): void {
  if (!isMapping(on)) throw new WorkflowError('on must be a mapping of trigger sources')
  rejectUnknown('on', on, ON_KEYS)
  if (!Object.keys(on).length) throw new WorkflowError('on needs at least one source: cron, sentry or command')

  if (on.cron !== undefined) {
    if (typeof on.cron !== 'string') throw new WorkflowError('on.cron must be a cron expression string')
    try {
      parseCron(on.cron)
    } catch (err) {
      throw new WorkflowError(`on.cron: ${(err as Error).message}`)
    }
  }

  if (on.sentry !== undefined) {
    const sentry = on.sentry
    if (!isMapping(sentry)) throw new WorkflowError('on.sentry must be a mapping with org and project')
    rejectUnknown('on.sentry', sentry, SENTRY_KEYS)
    for (const key of ['org', 'project'] as const) {
      if (typeof sentry[key] !== 'string' || !sentry[key]) throw new WorkflowError(`on.sentry.${key} is required`)
    }
    for (const key of ['query', 'match', 'url'] as const) {
      if (sentry[key] !== undefined && typeof sentry[key] !== 'string') throw new WorkflowError(`on.sentry.${key} must be a string`)
    }
    if (typeof sentry.match === 'string') {
      try {
        new RegExp(sentry.match)
      } catch (err) {
        throw new WorkflowError(`on.sentry.match is not a valid regular expression: ${(err as Error).message}`)
      }
    }
    if (sentry.interval_sec !== undefined && !(typeof sentry.interval_sec === 'number' && Number.isFinite(sentry.interval_sec) && sentry.interval_sec >= 5)) {
      throw new WorkflowError('on.sentry.interval_sec must be a number of seconds >= 5')
    }
  }

  if (on.command !== undefined) {
    const command = on.command
    if (!isMapping(command)) throw new WorkflowError('on.command must be a mapping with run')
    rejectUnknown('on.command', command, COMMAND_SOURCE_KEYS)
    if (typeof command.run !== 'string' || !command.run) throw new WorkflowError('on.command.run is required')
    if (referencesSteps(command.run)) {
      throw new WorkflowError('on.command.run: {{steps.*}} and {{event.*}} are not allowed in a shell line')
    }
    if (command.interval_sec !== undefined && !(typeof command.interval_sec === 'number' && Number.isFinite(command.interval_sec) && command.interval_sec >= 1)) {
      throw new WorkflowError('on.command.interval_sec must be a number of seconds >= 1')
    }
    if (command.timeout_min !== undefined && !(typeof command.timeout_min === 'number' && Number.isFinite(command.timeout_min) && command.timeout_min >= 0)) {
      throw new WorkflowError('on.command.timeout_min must be a number of minutes >= 0')
    }
  }
}

function validateTools(where: string, harness: string, tools: unknown[]): void {
  if (!Array.isArray(tools)) throw new WorkflowError(`${where}: tools must be a list`)
  if (!TOOL_HARNESSES.has(harness)) {
    throw new WorkflowError(
      `${where}: harness "${harness}" cannot mount tools — only ${[...TOOL_HARNESSES].join(' and ')} speak MCP`
    )
  }
  const names = new Set<string>()
  for (const tool of tools) {
    if (!isMapping(tool)) throw new WorkflowError(`${where}: every tool must be a mapping`)
    const kinds = ['mcp', 'flora'].filter((k) => k in tool)
    if (kinds.length !== 1) throw new WorkflowError(`${where}: a tool is either { mcp: … } or { flora: … }`)

    if ('mcp' in tool) {
      rejectUnknown(`${where}: tool`, tool, new Set(['mcp']))
      const mcp = tool.mcp
      if (!isMapping(mcp)) throw new WorkflowError(`${where}: tools.mcp must be a mapping with name and command`)
      rejectUnknown(`${where}: tools.mcp`, mcp, MCP_TOOL_KEYS)
      if (typeof mcp.name !== 'string' || !STEP_ID.test(mcp.name)) {
        throw new WorkflowError(`${where}: tools.mcp.name must be a plain identifier (it prefixes the tool names)`)
      }
      if (mcp.name === 'flora' || names.has(mcp.name)) {
        throw new WorkflowError(`${where}: tool server name "${mcp.name}" is taken`)
      }
      names.add(mcp.name)
      if (typeof mcp.command !== 'string' || !mcp.command) {
        throw new WorkflowError(`${where}: tools.mcp.command is required`)
      }
      if (mcp.args !== undefined && !(Array.isArray(mcp.args) && mcp.args.every((a) => typeof a === 'string'))) {
        throw new WorkflowError(`${where}: tools.mcp.args must be a list of strings`)
      }
      if (mcp.env !== undefined && !(isMapping(mcp.env) && Object.values(mcp.env).every((v) => typeof v === 'string'))) {
        throw new WorkflowError(`${where}: tools.mcp.env must be a map of strings`)
      }
      const processArgs = [
        mcp.command,
        ...((mcp.args as string[] | undefined) ?? []),
        ...Object.values((mcp.env as Record<string, string> | undefined) ?? {})
      ]
      if (processArgs.some((text) => referencesSteps(text))) {
        throw new WorkflowError(
          `${where}: {{steps.*}} is not allowed in tool command/args/env — they start a process; the agent can call read_context instead`
        )
      }
      continue
    }

    if (tool.flora === 'call_workflow') {
      rejectUnknown(`${where}: tool`, tool, new Set(['flora', 'workflow']))
      if (typeof tool.workflow !== 'string' || !tool.workflow) {
        throw new WorkflowError(`${where}: call_workflow needs "workflow" (path to the workflow to run)`)
      }
      if (referencesSteps(tool.workflow)) throw new WorkflowError(`${where}: {{steps.*}} is not allowed in a workflow path`)
    } else if (tool.flora === 'read_context') {
      rejectUnknown(`${where}: tool`, tool, new Set(['flora']))
    } else {
      throw new WorkflowError(`${where}: unknown flora tool "${String(tool.flora)}" (known: call_workflow, read_context)`)
    }
  }
}

/** Resolve {{param}} placeholders across the step's prompt, run and checks. */
export function resolveParams(
  spec: WorkflowSpec,
  given: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = Object.create(null)
  for (const [name, def] of Object.entries(spec.params ?? {})) {
    const value = Object.hasOwn(given, name) ? given[name] : def.default
    if (value === undefined && def.required) {
      throw new WorkflowError(`missing required param: ${name} (pass --param ${name}=...)`)
    }
    if (value !== undefined) resolved[name] = value
  }
  for (const name of Object.keys(given)) {
    if (!(name in resolved)) resolved[name] = given[name]
  }
  return resolved
}

export function substitute(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? params[name] : whole
  )
}

/**
 * Resolve placeholders for one runnable body. Prompts and check expectations
 * see the whole run context (params, earlier outputs, the trigger event);
 * anything that reaches a shell — `run` and artifact paths — sees params only.
 */
function substituteBody<T extends Pick<BranchSpec, 'prompt' | 'run' | 'verify'>>(body: T, context: RunContext): T {
  const shell = (t: string | undefined): string | undefined =>
    t === undefined ? undefined : substitute(t, context.params)
  const data = (t: string | undefined): string | undefined =>
    t === undefined ? undefined : substituteContext(t, context)
  return {
    ...body,
    prompt: data(body.prompt),
    run: shell(body.run),
    verify: (body.verify ?? []).map((check) => ({
      ...check,
      run: shell(check.run),
      path: shell(check.path),
      contains: data(check.contains),
      expect_match: data(check.expect_match)
    }))
  }
}

export function substituteStep(step: StepSpec, context: RunContext): StepSpec {
  const resolved = substituteBody(step, context)
  if (step.when !== undefined) resolved.when = substituteContext(step.when, context)
  if (!step.parallel) return resolved
  return {
    ...resolved,
    parallel: { ...step.parallel, branches: step.parallel.branches.map((branch) => substituteBody(branch, context)) }
  }
}
