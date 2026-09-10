import type { RunEvent, RunRecord, StepResult } from './types'
import { HEARTBEAT_MS, type EventToAppend, type RunStore } from './state'

/** Coalescing window for executor output — a chatty harness must not become a row per chunk. */
export const OUTPUT_FLUSH_MS = 250
export const OUTPUT_FLUSH_BYTES = 4096
/** How much output stays readable in the live feed; the full text lives in the step's evidence. */
export const OUTPUT_KEEP_BYTES = 64 * 1024

export interface Recorder {
  write(event: RunEvent): void
  close(): void
}

export interface RecorderContext {
  cwd: string
  params: Record<string, string>
}

/**
 * Turns the engine's event stream into journal rows, so `flora serve` can
 * follow a run happening in another process.
 *
 * This lives outside the engine on purpose: `runWorkflow` already exposes
 * `onEvent`, and pushing SQLite into the core would give the library a storage
 * dependency it does not need (architecture principle 3). The CLI composes the
 * two; the engine stays a pure function of its inputs.
 */
export function createRecorder(store: RunStore, context: RecorderContext): Recorder {
  let runId: string | null = null
  let record: RunRecord | null = null

  let pendingStepId: string | null = null
  let pendingText = ''
  let flushTimer: NodeJS.Timeout | null = null
  // A sign of life between saves: a step can run for an hour without a
  // state change, and a reader has to tell "still working" from "dead".
  let heartbeat: NodeJS.Timeout | null = null
  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
  }

  const append = (type: string, payload: Record<string, unknown>): void => {
    if (!runId) return
    const row: EventToAppend = { at: new Date().toISOString(), type, payload }
    store.appendEvents(runId, [row])
  }

  const flushOutput = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!pendingText || !pendingStepId || !runId) return
    const [stepId, branch] = pendingStepId.split('#')
    append('executor_output', { stepId, chunk: pendingText, ...(branch !== undefined ? { branch: Number(branch) } : {}) })
    pendingText = ''
    store.trimOutputEvents(runId, OUTPUT_KEEP_BYTES)
  }

  const scheduleFlush = (): void => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushOutput()
    }, OUTPUT_FLUSH_MS)
    // A pending flush must never be the reason the CLI stays alive.
    flushTimer.unref?.()
  }

  const stepFor = (stepId: string): StepResult | undefined =>
    record?.steps.find((step) => step.stepId === stepId)

  const save = (): void => {
    if (record) store.save(record)
  }

  return {
    write(event: RunEvent): void {
      if (event.type === 'executor_output') {
        // Branches of a parallel step interleave; keep their chunks apart.
        const stepId = event.branch === undefined ? String(event.stepId) : `${String(event.stepId)}#${String(event.branch)}`
        if (pendingStepId && pendingStepId !== stepId) flushOutput()
        pendingStepId = stepId
        pendingText += String(event.chunk ?? '')
        if (pendingText.length >= OUTPUT_FLUSH_BYTES) flushOutput()
        else scheduleFlush()
        return
      }

      // Anything else is a state change, so the buffered output has to land
      // first or the feed would show it happening after the fact.
      flushOutput()

      switch (event.type) {
        case 'run_start': {
          runId = String(event.runId)
          record = {
            runId,
            workflow: String(event.workflow),
            cwd: context.cwd,
            params: context.params,
            status: 'running',
            startedAt: new Date().toISOString(),
            steps: []
          }
          append('run_start', { workflow: record.workflow, steps: event.steps })
          save()
          heartbeat = setInterval(() => {
            if (runId) store.heartbeat(runId)
          }, HEARTBEAT_MS)
          heartbeat.unref?.()
          return
        }
        case 'step_start': {
          const stepId = String(event.stepId)
          const started: StepResult = {
            stepId,
            title: event.title ? String(event.title) : undefined,
            harness: event.harness ? String(event.harness) : undefined,
            attempt: Number(event.attempt ?? 1),
            status: 'running',
            checks: []
          }
          const existing = stepFor(stepId)
          if (existing) Object.assign(existing, started)
          else record?.steps.push(started)
          append('step_start', {
            stepId,
            title: started.title,
            harness: started.harness,
            attempt: started.attempt,
            maxAttempts: event.maxAttempts
          })
          save()
          return
        }
        case 'step_verifying':
          append('step_verifying', { stepId: event.stepId, checks: event.checks, branch: event.branch })
          return
        case 'step_skipped': {
          const stepId = String(event.stepId)
          const skipped: StepResult = {
            stepId,
            title: event.title ? String(event.title) : undefined,
            attempt: 0,
            status: 'skipped',
            checks: [],
            skipReason: event.when ? String(event.when) : undefined
          }
          const existing = stepFor(stepId)
          if (existing) Object.assign(existing, skipped)
          else record?.steps.push(skipped)
          append('step_skipped', { stepId, title: skipped.title, when: skipped.skipReason })
          save()
          return
        }
        case 'branch_start':
          append('branch_start', { stepId: event.stepId, branch: event.branch, title: event.title, harness: event.harness })
          return
        case 'branch_result':
          append('branch_result', { stepId: event.stepId, branch: event.branch, status: event.status, patch: event.patch })
          return
        case 'check_result':
          // The engine does not carry the CheckSpec on this event, so the live
          // view shows pass/fail plus detail; the full contract arrives with
          // the finished record once the run ends.
          append('check_result', { stepId: event.stepId, passed: event.passed, detail: event.detail, branch: event.branch })
          return
        case 'step_result': {
          const step = stepFor(String(event.stepId))
          if (step) {
            step.status = event.status === 'passed' ? 'passed' : 'failed'
            step.attempt = Number(event.attempt ?? step.attempt)
          }
          append('step_result', { stepId: event.stepId, status: event.status, attempt: event.attempt, error: event.error })
          save()
          return
        }
        case 'run_end': {
          if (event.record) record = event.record as RunRecord
          if (record) {
            record.status = event.status as RunRecord['status']
            record.finishedAt = new Date().toISOString()
            if (event.status === 'error') for (const step of record.steps) {
              if (step.status === 'running' || step.status === 'verifying') {
                step.status = 'failed'
                step.error = String(event.error ?? 'run aborted')
              }
            }
          }
          save()
          append('run_end', { status: event.status, failedStep: event.failedStep, error: event.error })
          stopHeartbeat()
          return
        }
        default:
          return
      }
    },

    close(): void {
      flushOutput()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      stopHeartbeat()
    }
  }
}
