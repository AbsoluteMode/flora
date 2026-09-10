import { readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { nextCron, parseCron } from './cron'
import { runWorkflow } from './engine'
import { createRecorder } from './recorder'
import { RunStore } from './state'
import { backoffMs, cronEvent, pollCommand, pollSentry, type TriggerEvent } from './triggers'
import { loadWorkflow } from './workflow'
import type { RunRecord, WorkflowSpec } from './types'

export interface WatchedWorkflow {
  path: string
  spec: WorkflowSpec
}

/** Workflow files (or directories of them) that declare `on:`; the rest are ignored. */
export function discoverWorkflows(paths: string[]): WatchedWorkflow[] {
  const files: string[] = []
  for (const path of paths) {
    const full = resolve(path)
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full, { recursive: true, encoding: 'utf8' })) {
        if (/\.ya?ml$/.test(extname(entry))) files.push(join(full, entry))
      }
    } else {
      files.push(full)
    }
  }
  return files
    .sort()
    .map((path) => ({ path, spec: loadWorkflow(path) }))
    .filter((wf) => wf.spec.on !== undefined)
}

export type Runner = (workflow: WatchedWorkflow, event: TriggerEvent) => Promise<RunRecord>

export interface WatchOptions {
  paths: string[]
  /** Directory triggered runs execute in. */
  cwd: string
  /** Params handed to every triggered run (`flora watch --param k=v`). */
  params?: Record<string, string>
  store?: RunStore
  log?: (line: string) => void
  /** Replaces the engine — tests use it to count runs without spawning anything. */
  runner?: Runner
  now?: () => Date
  /** Days a fingerprint stays in seen_events. */
  retentionDays?: number
}

interface WorkflowState {
  workflow: WatchedWorkflow
  running: boolean
  queue: TriggerEvent[]
  timers: NodeJS.Timeout[]
  failures: Map<string, number>
}

const QUEUE_LIMIT = 100

/**
 * `flora watch`: fires workflows from cron schedules and polled sources.
 * One run per workflow at a time — cron ticks that land during a run are
 * skipped; polled events are deduplicated and queued in memory. Pending events
 * can be lost on process exit. Every trigger is one ordinary run through the engine
 * and recorder, so the viewer shows it like any other, tagged with its source.
 */
export class Watcher {
  private readonly states: WorkflowState[]
  private readonly store: RunStore
  private readonly ownsStore: boolean
  private readonly log: (line: string) => void
  private readonly now: () => Date
  private readonly runner: Runner
  private readonly active = new Set<Promise<void>>()
  private readonly polls = new Set<Promise<TriggerEvent[]>>()
  private readonly pollAbort = new AbortController()
  private stopped = false
  private started = false
  private stopping?: Promise<void>

  constructor(private readonly options: WatchOptions) {
    this.store = options.store ?? new RunStore()
    this.ownsStore = !options.store
    this.log = options.log ?? ((line) => console.error(line))
    this.now = options.now ?? (() => new Date())
    this.runner = options.runner ?? ((workflow, event) => this.runWithEngine(workflow, event))
    this.states = discoverWorkflows(options.paths).map((workflow) => ({
      workflow,
      running: false,
      queue: [],
      timers: [],
      failures: new Map()
    }))
    this.store.pruneSeen(options.retentionDays ?? 30)
  }

  get workflows(): WatchedWorkflow[] {
    return this.states.map((s) => s.workflow)
  }

  /** Arm every schedule and poller; returns immediately. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    for (const state of this.states) {
      const on = state.workflow.spec.on!
      if (on.cron) this.scheduleCron(state, on.cron)
      if (on.sentry) this.schedulePoll(state, 'sentry', (on.sentry.interval_sec ?? 60) * 1000, () => pollSentry(on.sentry!, undefined, this.pollAbort.signal))
      if (on.command) {
        this.schedulePoll(state, 'command', (on.command.interval_sec ?? 300) * 1000, () =>
          pollCommand(on.command!, this.options.cwd, this.pollAbort.signal)
        )
      }
      this.log(`[flora watch] ${state.workflow.spec.name}: ${describe(state.workflow.spec)}`)
    }
  }

  /** One polling pass over every source (cron does not fire here), waiting for the runs it starts. */
  async once(): Promise<number> {
    if (this.stopped) return 0
    let started = 0
    for (const state of this.states) {
      const on = state.workflow.spec.on!
      const sources: Array<[string, () => Promise<TriggerEvent[]>]> = []
      if (on.sentry) sources.push(['sentry', () => pollSentry(on.sentry!, undefined, this.pollAbort.signal)])
      if (on.command) sources.push(['command', () => pollCommand(on.command!, this.options.cwd, this.pollAbort.signal)])
      for (const [name, poll] of sources) {
        try {
          for (const event of await this.poll(poll)) {
            if (await this.trigger(state, event)) started++
          }
        } catch (err) {
          this.log(`[flora watch] ${state.workflow.spec.name}: ${name} poll failed: ${(err as Error).message}`)
        }
      }
    }
    await Promise.all(this.active)
    return started
  }

  /** Cancel polling and drain it before closing the journal; running workflows finish normally. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    this.pollAbort.abort()
    for (const state of this.states) {
      for (const timer of state.timers) clearTimeout(timer)
      state.timers = []
      state.queue = []
    }
    this.stopping = (async () => {
      await Promise.allSettled(this.polls)
      await Promise.all(this.active)
      if (this.ownsStore) this.store.close()
    })()
    return this.stopping
  }

  private async poll(action: () => Promise<TriggerEvent[]>): Promise<TriggerEvent[]> {
    if (this.stopped) return []
    const job = action()
    this.polls.add(job)
    try { return await job } finally { this.polls.delete(job) }
  }

  private scheduleCron(state: WorkflowState, expr: string): void {
    const spec = parseCron(expr)
    const arm = (): void => {
      if (this.stopped) return
      const now = this.now()
      const next = nextCron(spec, now)
      const timer = setTimeout(() => {
        state.timers = state.timers.filter((t) => t !== timer)
        const at = this.now()
        if (state.running) {
          this.log(`[flora watch] ${state.workflow.spec.name}: cron tick skipped, a run is in progress`)
        } else {
          void this.trigger(state, cronEvent(expr, at)).catch((err) => this.log(`[flora watch] trigger failed: ${String(err)}`))
        }
        arm()
      }, Math.max(0, next.getTime() - now.getTime()))
      state.timers.push(timer)
    }
    arm()
  }

  private schedulePoll(state: WorkflowState, name: string, intervalMs: number, poll: () => Promise<TriggerEvent[]>): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) return
      let delay = intervalMs
      try {
        for (const event of await this.poll(poll)) {
          void this.trigger(state, event).catch((err) => this.log(`[flora watch] trigger failed: ${String(err)}`))
        }
        state.failures.set(name, 0)
      } catch (err) {
        if (this.stopped) return
        const failures = (state.failures.get(name) ?? 0) + 1
        state.failures.set(name, failures)
        delay = backoffMs(intervalMs, failures)
        this.log(
          `[flora watch] ${state.workflow.spec.name}: ${name} poll failed (${failures}×): ${(err as Error).message}; next try in ${Math.round(delay / 1000)}s`
        )
      }
      if (this.stopped) return
      const timer = setTimeout(() => {
        state.timers = state.timers.filter((t) => t !== timer)
        void tick()
      }, delay)
      state.timers.push(timer)
    }
    void tick()
  }

  /** Dedup, then run or queue. Resolves once the run (if any) has finished; true if a run started. */
  private async trigger(state: WorkflowState, event: TriggerEvent): Promise<boolean> {
    if (this.stopped) return false
    const name = state.workflow.spec.name
    if (state.running && state.queue.length >= QUEUE_LIMIT) {
      this.log(`[flora watch] ${name}: queue is full, leaving ${event.source} event ${event.id} for a later poll`)
      return false
    }
    if (!this.store.markSeen(event.source, event.id, name)) return false
    if (state.running) {
      state.queue.push(event)
      this.log(`[flora watch] ${name}: queued ${event.source} event ${event.id} behind the current run`)
      return true
    }
    await this.run(state, event)
    return true
  }

  private async run(state: WorkflowState, event: TriggerEvent): Promise<void> {
    const name = state.workflow.spec.name
    state.running = true
    const job = (async () => {
      try {
        this.log(`[flora watch] ${name}: run started by ${event.source} event ${event.id}`)
        const record = await this.runner(state.workflow, event)
        this.store.attachRun(event.source, event.id, name, record.runId)
        this.log(`[flora watch] ${name}: run ${record.runId} ${record.status}`)
      } catch (err) {
        this.log(`[flora watch] ${name}: run failed to start: ${(err as Error).message}`)
      } finally {
        state.running = false
      }
    })()
    this.active.add(job)
    await job
    this.active.delete(job)
    const next = state.queue.shift()
    if (next && !this.stopped) await this.run(state, next)
  }

  private async runWithEngine(workflow: WatchedWorkflow, event: TriggerEvent): Promise<RunRecord> {
    const params = this.options.params ?? {}
    const recorder = createRecorder(this.store, { cwd: this.options.cwd, params })
    try {
      const record = await runWorkflow(workflow.spec, {
        cwd: this.options.cwd,
        params,
        source: workflow.path,
        event,
        trigger: { source: event.source, id: event.id },
        onEvent: (e) => recorder.write(e)
      })
      this.store.save(record)
      return record
    } finally {
      recorder.close()
    }
  }
}

function describe(spec: WorkflowSpec): string {
  const on = spec.on!
  const parts: string[] = []
  if (on.cron) parts.push(`cron "${on.cron}"`)
  if (on.sentry) parts.push(`sentry ${on.sentry.org}/${on.sentry.project} every ${on.sentry.interval_sec ?? 60}s`)
  if (on.command) parts.push(`command every ${on.command.interval_sec ?? 300}s`)
  return parts.join(', ')
}
