import type { Evidence, RunRecord, StepResult, Usage } from './types'

/**
 * What a run spent, per step and in total, read from the journal.
 *
 * Every attempt counts (a retry is not free), every branch of a parallel step
 * counts, and a step whose harness reported nothing shows as blank rather
 * than zero — "0 tokens" would be a claim the journal cannot back.
 */
export interface UsageLine {
  stepId: string
  title?: string
  harness?: string
  status: StepResult['status']
  /** Attempts that ran (the final one plus the retries before it). */
  attempts: number
  calls?: number
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  /** Reported total, or input + output when only the parts were reported. */
  totalTokens?: number
  costUsd?: number
  /** True when at least one attempt or branch reported tokens or money. */
  reported: boolean
}

export interface RunUsage {
  runId: string
  workflow: string
  status: RunRecord['status']
  steps: UsageLine[]
  total: UsageLine
}

const NUMERIC: Array<keyof Usage & keyof UsageLine> = ['calls', 'inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens']

function add(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a + b
}

/** Sums of prices stay readable: 0.1 + 0.2 is 0.3, not 0.30000000000000004. */
function money(a: number | undefined, b: number | undefined): number | undefined {
  const sum = add(a, b)
  return sum === undefined ? undefined : Math.round(sum * 1e6) / 1e6
}

/** Fold one piece of evidence into a line. */
function fold(line: UsageLine, evidence: Pick<Evidence, 'usage' | 'costUsd'> | undefined): void {
  if (!evidence) return
  const usage = evidence.usage
  if (usage) {
    for (const key of NUMERIC) line[key] = add(line[key], usage[key])
    if (usage.totalTokens === undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
      line.totalTokens = add(line.totalTokens, (usage.contextTokens ?? usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
    }
  }
  const cost = evidence.costUsd ?? usage?.costUsd
  if (cost !== undefined) line.costUsd = money(line.costUsd, cost)
  if (usage || cost !== undefined) line.reported = true
}

/** Evidence of one attempt: the step's own, or its branches' when it ran in parallel. */
function attemptEvidence(step: StepResult): Array<Pick<Evidence, 'usage' | 'costUsd'> | undefined> {
  if (step.branches?.length) return step.branches.map((b) => b.evidence)
  return [step.evidence]
}

export function usageOfStep(step: StepResult): UsageLine {
  const line: UsageLine = {
    stepId: step.stepId,
    title: step.title,
    harness: step.harness,
    status: step.status,
    attempts: step.status === 'skipped' ? 0 : 1 + (step.priorAttempts?.length ?? 0),
    reported: false
  }
  for (const evidence of attemptEvidence(step)) fold(line, evidence)
  for (const earlier of step.priorAttempts ?? []) fold(line, earlier.evidence)
  return line
}

export function runUsage(record: RunRecord): RunUsage {
  const steps = record.steps.map(usageOfStep)
  const total: UsageLine = { stepId: 'total', status: record.status === 'passed' ? 'passed' : 'failed', attempts: 0, reported: false }
  for (const line of steps) {
    total.attempts += line.attempts
    for (const key of NUMERIC) total[key] = add(total[key], line[key])
    total.costUsd = money(total.costUsd, line.costUsd)
    total.reported ||= line.reported
  }
  return { runId: record.runId, workflow: record.workflow, status: record.status, steps, total }
}

// ── text rendering (the CLI) ────────────────────────────────────────────────

const COLUMNS: Array<{ key: keyof UsageLine; head: string; width: number }> = [
  { key: 'attempts', head: 'attempts', width: 8 },
  { key: 'calls', head: 'calls', width: 6 },
  { key: 'inputTokens', head: 'input', width: 11 },
  { key: 'outputTokens', head: 'output', width: 10 },
  { key: 'totalTokens', head: 'total', width: 11 },
  { key: 'costUsd', head: 'cost', width: 9 }
]

export function formatTokens(n: number | undefined): string {
  return n === undefined ? '–' : n.toLocaleString('en-US')
}

export function formatCost(n: number | undefined): string {
  if (n === undefined) return '–'
  return `$${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4)}`
}

function cell(line: UsageLine, key: keyof UsageLine): string {
  const value = line[key]
  if (key === 'costUsd') return formatCost(value as number | undefined)
  if (key === 'attempts') return line.attempts ? String(line.attempts) : '–'
  return formatTokens(value as number | undefined)
}

/**
 * A table with one row per step and a total — the shape of an invoice, not a
 * log. Steps that reported nothing keep their row with dashes, so a blank is
 * visibly "unreported" and not "free".
 */
export function formatUsageTable(usage: RunUsage): string {
  const rows = usage.steps.filter((s) => s.status !== 'skipped')
  const width = Math.max(4, ...rows.map((s) => s.stepId.length))
  const head = ['step'.padEnd(width), ...COLUMNS.map((c) => c.head.padStart(c.width))].join('  ')
  const line = (s: UsageLine): string => [s.stepId.padEnd(width), ...COLUMNS.map((c) => cell(s, c.key).padStart(c.width))].join('  ')
  return [head, ...rows.map(line), '', line({ ...usage.total, stepId: 'total' })].join('\n')
}
