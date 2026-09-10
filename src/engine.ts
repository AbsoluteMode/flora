import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BranchSpec, Evidence, PriorAttempt, RunEventHandler, RunRecord, StepArtifact, StepResult, StepSpec, Usage, WorkflowSpec } from './types'
import { adapterFor } from './adapters/index'
import { buildContext } from './context'
import { explainFailure } from './doctor'
import { addWorktree, isDirty, isGitRepo, pruneWorktrees, removeWorktree, worktreePatch } from './git'
import { readOutput } from './output'
import { floraHome } from './paths'
import { mcpServersFor } from './tools'
import { evaluateWhen } from './when'
import { parseRequire, resolveParams, substituteStep, validateWorkflow } from './workflow'
import { runChecks } from './verifier'
import { containedPath, validateFileName } from './safe-path'

export interface RunOptions {
  /** Preallocated by nonblocking callers so they can immediately return the journal ID. */
  runId?: string
  cwd: string
  params?: Record<string, string>
  signal?: AbortSignal
  onEvent?: RunEventHandler
  /** Path of the workflow file, when known — it joins the call stack nested runs check for cycles. */
  source?: string
  /** Nesting depth of this run (root = 0); call_workflow refuses to go past FLORA_MAX_DEPTH. */
  depth?: number
  /** Workflow files of the runs above this one. */
  stack?: string[]
  /** The run whose step started this one through call_workflow. */
  parentRunId?: string
  /** The trigger event (`flora watch`): reachable as {{event.*}} and in $FLORA_CONTEXT. */
  event?: unknown
  /** Which source and event started this run, for the journal. */
  trigger?: { source: string; id: string }
  /** Where branch patches are kept; default `<flora home>/runs/<runId>`. */
  artifactsDir?: string
}

/** How many steps or parallel branches may run at once. `FLORA_MAX_PARALLEL` overrides. */
export const DEFAULT_MAX_PARALLEL = 3

export function maxParallel(): number {
  const raw = Number(process.env.FLORA_MAX_PARALLEL)
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_MAX_PARALLEL
}

/** What a step body (a step, or one branch of a parallel step) needs from the run. */
interface RunScope {
  record: RunRecord
  params: Record<string, string>
  options: RunOptions
  onEvent: RunEventHandler
  /** Environment for the executor and the checks: this step's $FLORA_CONTEXT. */
  env: Record<string, string>
  contextPath: string
  contextDir: string
  stack: string[]
  abort(): void
}

/** The executable part of a step or branch, after substitution. */
type Body = Pick<BranchSpec, 'title' | 'executor' | 'prompt' | 'run' | 'verify' | 'output' | 'tools'> & {
  id: string
  verify_in?: 'cwd' | 'worktree'
}

/**
 * The engine walks the workflow as a graph: a step waits for the steps in
 * `needs` (or, without `needs`, for the one above it), steps whose waits are
 * over run at the same time up to FLORA_MAX_PARALLEL, a `when` that does not
 * hold skips the step, and one failure stops everything new. Each step:
 * executor runs → output contract is read → verifier judges → pass or retry
 * per on_fail. A parallel step fans its branches out in worktrees.
 */
export async function runWorkflow(spec: WorkflowSpec, options: RunOptions): Promise<RunRecord> {
  validateWorkflow(spec)
  if (options.runId !== undefined) validateFileName(options.runId)
  const abort = new AbortController()
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal }
  const onEvent: RunEventHandler = options.onEvent ?? (() => {})
  const params = resolveParams(spec, options.params ?? {})
  // {{workflow_dir}}: where the workflow file lives, so a step can name its
  // own scripts and prompts wherever the folder — or the bundle — ends up.
  const injectedDir = options.source !== undefined && params.workflow_dir === undefined
  if (injectedDir) params.workflow_dir = dirname(resolve(options.source!))
  const record: RunRecord = {
    runId: options.runId ?? randomUUID(),
    workflow: spec.name,
    cwd: options.cwd,
    // The journal keeps what the caller passed; a placeholder flora filled in is not a parameter.
    params: injectedDir ? Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'workflow_dir')) : params,
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: [],
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.trigger ? { trigger: options.trigger } : {})
  }
  onEvent({ type: 'run_start', runId: record.runId, workflow: spec.name, steps: spec.steps.length })
  const stack = [...(options.stack ?? []), ...(options.source ? [options.source] : [])]

  // Data reaches shell steps through a file, never through interpolation:
  // every step gets its own $FLORA_CONTEXT snapshot, taken when it starts.
  const contextDir = join(tmpdir(), `flora-${record.runId}`)
  mkdirSync(contextDir, { recursive: true })

  const finish = (status: RunRecord['status'], extra: Record<string, unknown> = {}): RunRecord => {
    record.status = status
    record.finishedAt = new Date().toISOString()
    // A reader may react immediately to run_end, before the caller's final save.
    onEvent({ type: 'run_end', runId: record.runId, status, ...(status !== 'error' ? { record } : {}), ...extra })
    return record
  }

  // The graph: `needs` as declared, or the step above; results in file order.
  const index = new Map(spec.steps.map((step, i) => [step.id, i]))
  const dependsOn = spec.steps.map((step, i) =>
    step.needs ? step.needs.map((id) => index.get(id)!) : i > 0 ? [i - 1] : []
  )
  const results: Array<StepResult | null> = spec.steps.map(() => null)
  const running = new Map<number, Promise<void>>()
  const done = (i: number): boolean => results[i] !== null
  const finishedOk = (i: number): boolean => results[i]?.status === 'passed' || results[i]?.status === 'skipped'
  let failedStep: string | null = null
  let aborted = false

  const runStep = async (i: number): Promise<void> => {
    const rawStep = spec.steps[i]
    const finished = results.filter((r): r is StepResult => r !== null)
    const context = buildContext(params, finished, options.event)
    const contextPath = join(contextDir, `context-${rawStep.id}.json`)
    writeFileSync(contextPath, JSON.stringify(context, null, 2))
    const scope: RunScope = {
      record,
      params,
      options,
      onEvent,
      env: { FLORA_CONTEXT: contextPath },
      contextPath,
      contextDir,
      stack,
      abort: () => abort.abort()
    }
    const step = substituteStep(rawStep, context)

    if (step.when !== undefined) {
      const verdict = evaluateWhen(step.when)
      if (!verdict.holds) {
        onEvent({ type: 'step_skipped', stepId: step.id, title: step.title, when: verdict.reason })
        results[i] = {
          stepId: step.id,
          title: step.title,
          harness: step.parallel ? 'parallel' : step.executor!.harness,
          attempt: 0,
          status: 'skipped',
          checks: [],
          skipReason: verdict.reason
        }
        return
      }
    }

    const maxAttempts = 1 + (step.on_fail?.retry ?? 0)
    let result: StepResult | null = null
    let contractError: string | undefined
    // What the earlier attempts cost stays on the record: a retry is not free.
    const prior: PriorAttempt[] = []
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.signal?.aborted) {
        aborted = true
        return
      }
      onEvent({
        type: 'step_start',
        stepId: step.id,
        title: step.title,
        attempt,
        maxAttempts,
        harness: step.parallel ? 'parallel' : step.executor!.harness
      })
      result = step.parallel
        ? await runParallel(step, attempt, scope)
        : await runBody({ ...step, executor: step.executor! }, options.cwd, attempt, contractError, scope)
      contractError = result.outputError
      const error = contractError ? `output contract: ${contractError}` : result.error
      onEvent({ type: 'step_result', stepId: step.id, status: result.status, attempt, error })
      if (result.status === 'passed') break
      if (attempt < maxAttempts) prior.push(priorAttempt(result))
    }
    if (prior.length) result!.priorAttempts = prior
    // The run's data flow, for the analytics: what this step drew on.
    const inputs = inputsOf(step)
    if (inputs.length) result!.inputsFrom = inputs
    results[i] = result
    if (result!.status !== 'passed') failedStep ??= result!.stepId
  }

  // Scheduler: start whatever is ready, wait for something to finish, repeat.
  const limit = maxParallel()
  try {
    while (results.some((r) => r === null)) {
      if (options.signal?.aborted) aborted = true
      if (!failedStep && !aborted) {
        for (let i = 0; i < spec.steps.length && running.size < limit; i++) {
          if (done(i) || running.has(i)) continue
          if (!dependsOn[i].every(finishedOk)) continue
          const job = runStep(i).finally(() => running.delete(i))
          running.set(i, job)
        }
      }
      if (!running.size) break // a failure or an abort left the rest unreachable
      await Promise.race(running.values())
    }
    record.steps = results.filter((r): r is StepResult => r !== null)
    if (aborted || options.signal?.aborted) return finish('error')
    if (failedStep) return finish('failed', { failedStep })
    return finish('passed')
  } catch (err) {
    abort.abort()
    await Promise.allSettled(running.values())
    // An observer can itself be the source of the error; preserve that original failure.
    try { finish('error', { error: err instanceof Error ? err.message : String(err) }) } catch {}
    throw err
  } finally {
    await rm(contextDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** The light trace of a failed attempt: outcome and what it spent, not its output. */
function priorAttempt(result: StepResult): PriorAttempt {
  const e = result.evidence
  const branches = result.branches?.map((b) => b.evidence).filter((b): b is Evidence => b !== undefined) ?? []
  // A parallel step's money sits on its branches; fold it so the attempt counts once.
  const evidence = e ?? (branches.length ? foldEvidence(branches) : undefined)
  return {
    attempt: result.attempt,
    status: result.status,
    ...(evidence
      ? {
          evidence: {
            durationMs: evidence.durationMs,
            exitCode: evidence.exitCode,
            ...(evidence.costUsd !== undefined ? { costUsd: evidence.costUsd } : {}),
            ...(evidence.usage ? { usage: evidence.usage } : {}),
            ...(evidence.stalled ? { stalled: true } : {}),
            ...(evidence.timedOut ? { timedOut: true } : {})
          }
        }
      : {})
  }
}

function foldEvidence(list: Evidence[]): Evidence {
  const sum = (pick: (e: Evidence) => number | undefined): number | undefined => {
    const values = list.map(pick).filter((v): v is number => typeof v === 'number')
    return values.length ? values.reduce((a, b) => a + b, 0) : undefined
  }
  const usage: Usage = {
    inputTokens: sum((e) => e.usage?.inputTokens),
    outputTokens: sum((e) => e.usage?.outputTokens),
    cachedTokens: sum((e) => e.usage?.cachedTokens),
    contextTokens: sum((e) => e.usage?.contextTokens),
    totalTokens: sum((e) => e.usage?.totalTokens),
    calls: sum((e) => e.usage?.calls)
  }
  for (const key of Object.keys(usage) as Array<keyof Usage>) if (usage[key] === undefined) delete usage[key]
  const costUsd = sum((e) => e.costUsd)
  return {
    output: '',
    exitCode: list.every((e) => e.exitCode === 0) ? 0 : null,
    durationMs: Math.max(...list.map((e) => e.durationMs)),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(Object.keys(usage).length ? { usage } : {})
  }
}

/** One executor run plus its contract and checks — a step, or one branch. */
async function runBody(
  body: Body,
  cwd: string,
  attempt: number,
  contractError: string | undefined,
  scope: RunScope,
  branch?: number
): Promise<StepResult> {
  const { options, onEvent, env } = scope
  const isAgent = body.executor.harness !== 'command'
  const at = branch === undefined ? {} : { branch }

  // A retry after a broken output contract tells the agent what was wrong.
  const prompt =
    contractError && isAgent && body.prompt !== undefined
      ? `${body.prompt}\n\nPrevious attempt failed the output contract: ${contractError}. Return valid output.`
      : body.prompt

  const adapter = adapterFor(body.executor.harness)
  const evidence = await adapter.execute({
    runId: scope.record.runId,
    stepId: body.id,
    spec: body.executor,
    prompt,
    run: body.run,
    cwd,
    signal: options.signal,
    env,
    output: body.output,
    // The tools contract, as MCP servers the harness starts itself; the
    // flora-native ones are this CLI with the step's context on the line.
    mcp: mcpServersFor(body.tools, {
      params: scope.params,
      contextPath: scope.contextPath,
      cwd,
      runId: scope.record.runId,
      depth: options.depth ?? 0,
      stack: scope.stack
    }),
    onOutput: (chunk) => onEvent({ type: 'executor_output', stepId: body.id, chunk, ...at })
  })

  onEvent({ type: 'step_verifying', stepId: body.id, checks: body.verify?.length ?? 0, ...at })
  // `verify_in: worktree`: the checks see the committed state only, so an
  // executor that left its work uncommitted (or in ignored files) fails them.
  let checkCwd = cwd
  let verifyWorktree: string | null = null
  let verifyError: string | undefined
  if (body.verify_in === 'worktree') {
    if (await isGitRepo(cwd)) {
      verifyWorktree = join(scope.contextDir, 'verify', body.id)
      mkdirSync(join(scope.contextDir, 'verify'), { recursive: true })
      await addWorktree(cwd, verifyWorktree)
      checkCwd = verifyWorktree
    } else {
      verifyError = `verify_in: worktree needs a git repository and ${cwd} is not one — commit the work there, or drop verify_in`
    }
  }
  let checks: Awaited<ReturnType<typeof runChecks>> = []
  try {
    if (!verifyError) checks = await runChecks(body.verify ?? [], checkCwd, options.signal, env)
  } finally {
    if (verifyWorktree) await removeWorktree(cwd, verifyWorktree).catch(() => rmSync(verifyWorktree!, { recursive: true, force: true }))
  }
  for (const check of checks) {
    onEvent({ type: 'check_result', stepId: body.id, passed: check.passed, detail: check.detail, ...at })
  }

  // Only a clean zero is a success. `null` means the harness never ran
  // (spawn failed) or died to a signal — neither is evidence of work done.
  const executorOk = evidence.exitCode === 0
  const output = executorOk ? readOutput(evidence.output, body.output, body.executor.harness) : null
  const error = output && !output.ok ? output.error : undefined
  // A harness that never got going (not installed, not logged in, a config
  // it cannot parse) gets the sentence a person needs, not just a transcript.
  const hint = executorOk ? undefined : explainFailure(body.executor.harness, evidence)
  const passed = executorOk && output !== null && output.ok && !verifyError && checks.every((c) => c.passed)
  // Files the step declared as its artifacts travel with the run.
  const artifacts = output && output.ok ? collectArtifacts(output.value, cwd, join(options.artifactsDir ?? join(floraHome(), 'runs', scope.record.runId), 'artifacts', branch === undefined ? body.id : `${body.id}-${branch}`)) : []
  return {
    stepId: body.id,
    title: body.title,
    harness: body.executor.harness,
    attempt,
    status: passed ? 'passed' : 'failed',
    evidence,
    checks,
    // The artefact keeps what was actually sent and run, not just the template.
    ...(isAgent && prompt !== undefined ? { prompt } : {}),
    ...(!isAgent && body.run !== undefined ? { command: body.run } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(verifyWorktree ? { verifiedIn: 'worktree' as const } : {}),
    ...(output && output.ok && output.value !== undefined ? { output: output.value, ...describeOutput(output.value) } : {}),
    ...(error ? { outputError: error } : {}),
    ...(hint ?? verifyError ? { error: hint ?? verifyError } : {})
  }
}

/**
 * What the analytics can say about a step's output on its own: how big it
 * is, and the numbers the step chose to report under `metrics` (`in`, `out`,
 * `posts`, whatever it counts). Only finite numbers are kept.
 */
function describeOutput(value: unknown): Pick<StepResult, 'outputBytes' | 'metrics'> {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const out: Pick<StepResult, 'outputBytes' | 'metrics'> = { outputBytes: Buffer.byteLength(text ?? '', 'utf8') }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = (value as Record<string, unknown>).metrics
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const metrics: Record<string, number> = Object.create(null)
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = v
      }
      if (Object.keys(metrics).length) out.metrics = metrics
    }
  }
  return out
}

/** A step's declared artifacts must stay small enough to travel with the run. */
const ARTIFACT_FILE_MAX = 32 * 1024 * 1024
const ARTIFACT_TOTAL_MAX = 256 * 1024 * 1024
const ARTIFACT_FILES_MAX = 2000

/**
 * `artifacts: ["usage.jsonl", "gui/02"]` in a step's output: the files (and
 * directories, recursively) it wants kept — prompts it sent, answers it got,
 * logs — copied under the run's artifact directory so the run record, the
 * report, the export and the viewer can hand them over. Paths are relative
 * to the step's working directory; what is missing or too big is skipped,
 * not fatal: the run's outcome is the verifier's business, not the copier's.
 */
function collectArtifacts(value: unknown, cwd: string, targetDir: string): StepArtifact[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const declared = (value as Record<string, unknown>).artifacts
  if (!Array.isArray(declared)) return []
  const out: StepArtifact[] = []
  let total = 0
  const add = (source: string, file: string, rel: string): void => {
    let info
    try {
      info = statSync(file)
    } catch {
      return
    }
    if (!info.isFile() || info.size > ARTIFACT_FILE_MAX || total + info.size > ARTIFACT_TOTAL_MAX || out.length >= ARTIFACT_FILES_MAX) return
    let target: string
    try { containedPath(cwd, relative(cwd, file).split(sep).join('/')); target = containedPath(targetDir, rel) } catch { return }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(file, target)
    total += info.size
    out.push({ path: relative(dirname(targetDir), target).split(sep).join('/'), source, bytes: info.size })
  }
  const walk = (dir: string, source: string, relBase: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, source, rel)
      else if (entry.isFile()) add(source, full, rel)
    }
  }
  for (const item of declared) {
    if (typeof item !== 'string' || !item.trim()) continue
    let file: string
    try { file = containedPath(cwd, item.replace(/\\/g, '/')) } catch { continue }
    let info
    try {
      info = statSync(file)
    } catch {
      continue
    }
    // Only files beneath the task directory may be selected by agent-produced output.
    const inside = relative(cwd, file)
    const name = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : basename(file)
    if (info.isDirectory()) walk(file, item, name)
    else add(item, file, name)
  }
  return out
}

/** The steps a step draws on: `needs`, plus every `{{steps.<id>…}}` in its texts. Order kept, no repeats. */
export function inputsOf(step: StepSpec): string[] {
  const ids = new Set<string>(step.needs ?? [])
  const texts: Array<string | undefined> = [step.when, step.prompt, step.run]
  for (const check of step.verify ?? []) texts.push(check.run, check.expect_match, check.contains, check.path)
  for (const branch of step.parallel?.branches ?? []) {
    texts.push(branch.prompt, branch.run)
    for (const check of branch.verify ?? []) texts.push(check.run, check.expect_match, check.contains, check.path)
  }
  for (const text of texts) {
    if (!text) continue
    for (const match of text.matchAll(/\{\{\s*steps\.([A-Za-z_][A-Za-z0-9_-]*)/g)) ids.add(match[1])
  }
  ids.delete(step.id)
  return [...ids]
}

/**
 * Fan-out. Every branch runs the same way a step does, at most
 * FLORA_MAX_PARALLEL at a time, each in a detached worktree of HEAD so they
 * cannot see each other (or the uncommitted working copy). What a branch
 * changed comes back as a patch; the policy decides whether the step passed.
 */
async function runParallel(step: StepSpec, attempt: number, scope: RunScope): Promise<StepResult> {
  const { options, onEvent, record } = scope
  const parallel = step.parallel!
  const policy = parseRequire(parallel.require, parallel.branches.length)
  const isolation = parallel.isolation ?? 'worktree'
  const cwd = options.cwd
  const base: StepResult = { stepId: step.id, title: step.title, harness: 'parallel', attempt, status: 'failed', checks: [] }

  if (isolation === 'worktree') {
    if (!(await isGitRepo(cwd))) {
      return {
        ...base,
        error: `parallel step needs a git repository for worktree isolation and ${cwd} is not one — commit the work there, or set parallel.isolation: shared`
      }
    }
    await pruneWorktrees(cwd)
    if (await isDirty(cwd)) {
      onEvent({
        type: 'executor_output',
        stepId: step.id,
        chunk: '[flora: the working copy has uncommitted changes; branches start from HEAD and will not see them]\n'
      })
    }
  }

  const artifactsDir = options.artifactsDir ?? join(floraHome(), 'runs', record.runId)
  const worktreesDir = join(scope.contextDir, 'worktrees')
  const limit = maxParallel()
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = (): Promise<void> =>
    new Promise((ok) => {
      if (active < limit) {
        active++
        ok()
      } else {
        waiting.push(ok)
      }
    })
  const release = (): void => {
    const next = waiting.shift()
    if (next) next()
    else active--
  }

  const settled = await Promise.allSettled(
    parallel.branches.map(async (branch, i) => {
      await acquire()
      try {
        const id = `${step.id}[${i}]`
        if (options.signal?.aborted) return { result: { ...base, stepId: id, error: 'aborted before branch start' }, patch: null }
        let branchCwd = cwd
        let worktree: string | null = null
        if (isolation === 'worktree') {
          worktree = join(worktreesDir, `${step.id}-${i}`)
          mkdirSync(worktreesDir, { recursive: true })
          await addWorktree(cwd, worktree)
          branchCwd = worktree
        }
        try {
          onEvent({ type: 'branch_start', stepId: step.id, branch: i, title: branch.title, harness: branch.executor.harness })
          const result = await runBody({ ...branch, id }, branchCwd, attempt, undefined, scope, i)
          let patch: string | null = null
          if (worktree) {
            const diff = await worktreePatch(cwd, worktree)
            if (diff.trim()) {
              mkdirSync(artifactsDir, { recursive: true })
              patch = join(artifactsDir, `${step.id}-${i}.diff`)
              writeFileSync(patch, diff)
            }
          }
          onEvent({ type: 'branch_result', stepId: step.id, branch: i, status: result.status, patch })
          return { result, patch }
        } finally {
          if (worktree) await removeWorktree(cwd, worktree).catch(() => rmSync(worktree!, { recursive: true, force: true }))
        }
      } catch (err) {
        scope.abort()
        throw err
      } finally {
        release()
      }
    })
  )
  const rejected = settled.find((outcome) => outcome.status === 'rejected')
  if (rejected?.status === 'rejected') throw rejected.reason
  const outcomes = settled.map((outcome) => (outcome as PromiseFulfilledResult<{ result: StepResult; patch: string | null }>).value)
  const results = outcomes.map((o) => o.result)
  const passedCount = results.filter((r) => r.status === 'passed').length
  const need = policy.kind === 'all' ? results.length : policy.kind === 'any' ? 1 : policy.n
  const passed = passedCount >= need
  return {
    ...base,
    status: passed ? 'passed' : 'failed',
    branches: results,
    outputs: results.map((r) => (r.status === 'passed' ? (r.output !== undefined ? r.output : (r.evidence?.output ?? null)) : null)),
    patches: outcomes.map((o) => o.patch),
    ...(passed ? {} : { error: `${passedCount} of ${results.length} branches passed; ${describeRequire(policy)} required` })
  }
}

function describeRequire(policy: ReturnType<typeof parseRequire>): string {
  return policy.kind === 'quorum' ? `a quorum of ${policy.n}` : policy.kind
}
