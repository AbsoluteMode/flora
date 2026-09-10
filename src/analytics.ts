import type { RunRecord, StepResult } from './types'
import { formatCost, formatTokens, usageOfStep } from './usage'
import { markdownText } from './markdown'

/**
 * What went in, what came out, what it cost — per step of a run, and the
 * edges between steps. Read from the journal: the engine records the data
 * flow (`inputsFrom`), the size of every output, the numbers a step reports
 * about itself (`metrics`: `in`, `out`, …) and the usage; this module only
 * lays them side by side. Nothing here calls a model or reads a file.
 */
export interface StepAnalytics {
  stepId: string
  title?: string
  harness?: string
  status: StepResult['status']
  /** Steps whose output this one used. */
  inputsFrom: string[]
  /** `metrics.in` / `metrics.out` when the step reported them. */
  in?: number
  out?: number
  /** Every reported metric, `in` and `out` included. */
  metrics: Record<string, number>
  durationMs?: number
  attempts: number
  calls?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
  outputBytes?: number
}

export interface RunAnalytics {
  runId: string
  workflow: string
  status: RunRecord['status']
  startedAt: string
  finishedAt?: string
  steps: StepAnalytics[]
  edges: Array<{ from: string; to: string }>
  totals: { steps: number; durationMs?: number; calls?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number; outputBytes?: number }
}

function add(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a + b
}

export function stepAnalytics(step: StepResult): StepAnalytics {
  const usage = usageOfStep(step)
  const metrics = step.metrics ?? {}
  const duration = step.evidence?.durationMs ?? (step.branches?.length ? Math.max(...step.branches.map((b) => b.evidence?.durationMs ?? 0)) : undefined)
  return {
    stepId: step.stepId,
    title: step.title,
    harness: step.harness,
    status: step.status,
    inputsFrom: step.inputsFrom ?? [],
    ...(typeof metrics.in === 'number' ? { in: metrics.in } : {}),
    ...(typeof metrics.out === 'number' ? { out: metrics.out } : {}),
    metrics,
    durationMs: duration,
    attempts: usage.attempts,
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    outputBytes: step.outputBytes ?? (step.branches?.length ? step.branches.reduce((s, b) => add(s, b.outputBytes), undefined as number | undefined) : undefined)
  }
}

export function runAnalytics(record: RunRecord): RunAnalytics {
  const steps = record.steps.map(stepAnalytics)
  const known = new Set(steps.map((s) => s.stepId))
  const edges = steps.flatMap((s) => s.inputsFrom.filter((from) => known.has(from)).map((from) => ({ from, to: s.stepId })))
  const totals: RunAnalytics['totals'] = { steps: steps.filter((s) => s.status !== 'skipped').length }
  for (const s of steps) {
    totals.durationMs = add(totals.durationMs, s.durationMs)
    totals.calls = add(totals.calls, s.calls)
    totals.inputTokens = add(totals.inputTokens, s.inputTokens)
    totals.outputTokens = add(totals.outputTokens, s.outputTokens)
    totals.totalTokens = add(totals.totalTokens, s.totalTokens)
    totals.costUsd = add(totals.costUsd, s.costUsd)
    totals.outputBytes = add(totals.outputBytes, s.outputBytes)
  }
  if (totals.costUsd !== undefined) totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6
  const wall = record.finishedAt ? Date.parse(record.finishedAt) - Date.parse(record.startedAt) : undefined
  return { runId: record.runId, workflow: record.workflow, status: record.status, startedAt: record.startedAt, finishedAt: record.finishedAt, steps, edges, totals: { ...totals, ...(wall !== undefined && Number.isFinite(wall) ? { durationMs: wall } : {}) } }
}

// ── rendering ────────────────────────────────────────────────────────────────

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '–'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '–'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const num = (n: number | undefined): string => (n === undefined ? '–' : n.toLocaleString('en-US'))
const flow = (s: Pick<StepAnalytics, 'in' | 'out'>): string => (s.in === undefined && s.out === undefined ? '–' : `${num(s.in)} → ${num(s.out)}`)

/** One row per step: where from, in → out, time, tokens, money, size. */
export function formatAnalyticsTable(a: RunAnalytics): string {
  const rows = a.steps.filter((s) => s.status !== 'skipped')
  const width = Math.max(4, ...rows.map((s) => s.stepId.length))
  const fromWidth = Math.max(4, ...rows.map((s) => s.inputsFrom.join(',').length))
  const columns: Array<[string, number, (s: StepAnalytics) => string]> = [
    ['from', fromWidth, (s) => s.inputsFrom.join(',') || '–'],
    ['in → out', 17, flow],
    ['took', 8, (s) => formatMs(s.durationMs)],
    ['calls', 6, (s) => num(s.calls)],
    ['tokens', 11, (s) => num(s.totalTokens)],
    ['cost', 9, (s) => formatCost(s.costUsd)],
    ['output', 9, (s) => formatBytes(s.outputBytes)]
  ]
  const head = ['step'.padEnd(width), ...columns.map(([h, w]) => (h === 'from' ? h.padEnd(w) : h.padStart(w)))].join('  ')
  const line = (s: StepAnalytics): string => [s.stepId.padEnd(width), ...columns.map(([h, w, f]) => (h === 'from' ? f(s).padEnd(w) : f(s).padStart(w)))].join('  ')
  const t = a.totals
  const total = ['total'.padEnd(width), ''.padEnd(fromWidth), ''.padStart(17), formatMs(t.durationMs).padStart(8), num(t.calls).padStart(6), num(t.totalTokens).padStart(11), formatCost(t.costUsd).padStart(9), formatBytes(t.outputBytes).padStart(9)].join('  ')
  const extras = rows.filter((s) => Object.keys(s.metrics).some((k) => k !== 'in' && k !== 'out'))
  const lines = [head, ...rows.map(line), '', total]
  if (extras.length) {
    lines.push('', 'metrics:')
    for (const s of extras) lines.push(`  ${s.stepId.padEnd(width)}  ${Object.entries(s.metrics).map(([k, v]) => `${k}=${num(v)}`).join('  ')}`)
  }
  return lines.join('\n')
}

/** The same table in markdown, for reports. */
export function analyticsMarkdown(a: RunAnalytics): string[] {
  const rows = a.steps.filter((s) => s.status !== 'skipped')
  const lines = ['| step | from | in → out | took | calls | tokens | cost | output |', '|---|---|---:|---:|---:|---:|---:|---:|']
  for (const s of rows) {
    lines.push(`| ${markdownText(s.stepId)} | ${markdownText(s.inputsFrom.join(', ') || '–')} | ${flow(s)} | ${formatMs(s.durationMs)} | ${num(s.calls)} | ${num(s.totalTokens)} | ${formatCost(s.costUsd)} | ${formatBytes(s.outputBytes)} |`)
  }
  const t = a.totals
  lines.push(`| **total** | | | ${formatMs(t.durationMs)} | ${num(t.calls)} | ${num(t.totalTokens)} | ${formatCost(t.costUsd)} | ${formatBytes(t.outputBytes)} |`)
  const extras = rows.filter((s) => Object.keys(s.metrics).some((k) => k !== 'in' && k !== 'out'))
  if (extras.length) {
    lines.push('', 'Reported metrics:', '')
    for (const s of extras) lines.push(`- **${markdownText(s.stepId)}**: ${Object.entries(s.metrics).map(([k, v]) => `${markdownText(k)} = ${num(v)}`).join(', ')}`)
  }
  return lines
}

/** The flow as a mermaid graph: one node per step with in → out and cost, one edge per input. */
export function mermaidFlow(a: RunAnalytics): string {
  const ids = new Map<string, string>()
  const reserved = new Set(a.steps.map((s) => s.stepId))
  const safe = (id: string): string => {
    if (!ids.has(id)) {
      let node = id
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(node) || node === 'end') {
        let suffix = ids.size
        do { node = `flora_node_${suffix++}` } while (reserved.has(node))
      }
      reserved.add(node)
      ids.set(id, node)
    }
    return ids.get(id)!
  }
  // Mermaid decimal entities preserve visible labels without letting them add syntax.
  const label = (value: string): string => value.replace(/[\r\n]+/g, ' ').replace(/["<>&#`\[\]{}\\]/g, (char) => `#${char.charCodeAt(0)};`)
  const lines = ['flowchart LR']
  for (const s of a.steps) {
    const bits = [label(s.stepId)]
    if (s.in !== undefined || s.out !== undefined) bits.push(flow(s))
    if (s.costUsd !== undefined) bits.push(formatCost(s.costUsd))
    const shape = s.status === 'skipped' ? `(["${bits.join('<br/>')}"])` : `["${bits.join('<br/>')}"]`
    lines.push(`  ${safe(s.stepId)}${shape}`)
  }
  for (const e of a.edges) lines.push(`  ${safe(e.from)} --> ${safe(e.to)}`)
  for (const s of a.steps) {
    if (s.status === 'failed') lines.push(`  style ${safe(s.stepId)} stroke:#d64545,stroke-width:2px`)
    if (s.status === 'skipped') lines.push(`  style ${safe(s.stepId)} stroke-dasharray: 4 3`)
  }
  return lines.join('\n')
}

// ── across runs: one row per step per run, for a spreadsheet ────────────────

export interface AnalyticsRow {
  run_id: string
  workflow: string
  run_status: string
  started_at: string
  step: string
  title: string
  step_status: string
  harness: string
  from: string
  in: number | ''
  out: number | ''
  metrics: string
  attempts: number
  duration_ms: number | ''
  calls: number | ''
  input_tokens: number | ''
  output_tokens: number | ''
  total_tokens: number | ''
  cost_usd: number | ''
  output_bytes: number | ''
}

export function analyticsRows(records: RunRecord[]): AnalyticsRow[] {
  const rows: AnalyticsRow[] = []
  for (const record of records) {
    const a = runAnalytics(record)
    for (const s of a.steps) {
      const extra = Object.fromEntries(Object.entries(s.metrics).filter(([k]) => k !== 'in' && k !== 'out'))
      rows.push({
        run_id: a.runId,
        workflow: a.workflow,
        run_status: a.status,
        started_at: a.startedAt,
        step: s.stepId,
        title: s.title ?? '',
        step_status: s.status,
        harness: s.harness ?? '',
        from: s.inputsFrom.join(' '),
        in: s.in ?? '',
        out: s.out ?? '',
        metrics: Object.keys(extra).length ? JSON.stringify(extra) : '',
        attempts: s.attempts,
        duration_ms: s.durationMs ?? '',
        calls: s.calls ?? '',
        input_tokens: s.inputTokens ?? '',
        output_tokens: s.outputTokens ?? '',
        total_tokens: s.totalTokens ?? '',
        cost_usd: s.costUsd ?? '',
        output_bytes: s.outputBytes ?? ''
      })
    }
  }
  return rows
}

/** RFC 4180-ish CSV with a UTF-8 BOM, so Excel opens it with the right encoding and a comma delimiter. */
export function toCsv(rows: AnalyticsRow[]): string {
  const columns = Object.keys(rows[0] ?? { run_id: '', workflow: '', run_status: '', started_at: '', step: '', title: '', step_status: '', harness: '', from: '', in: '', out: '', metrics: '', attempts: '', duration_ms: '', calls: '', input_tokens: '', output_tokens: '', total_tokens: '', cost_usd: '', output_bytes: '' })
  const cell = (v: unknown): string => {
    let text = v === undefined || v === null ? '' : String(v)
    if (typeof v === 'string' && /^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return '﻿' + [columns.join(','), ...rows.map((r) => columns.map((c) => cell((r as unknown as Record<string, unknown>)[c])).join(','))].join('\r\n') + '\r\n'
}

/** Per-run totals over time, for the `--all` view. */
export function formatRunsAnalytics(list: RunAnalytics[]): string {
  const width = Math.max(8, ...list.map((a) => a.workflow.length))
  const head = ['started'.padEnd(19), 'status'.padEnd(11), 'workflow'.padEnd(width), 'steps'.padStart(5), 'took'.padStart(8), 'calls'.padStart(6), 'tokens'.padStart(11), 'cost'.padStart(9), 'run'].join('  ')
  const lines = [head]
  for (const a of list) {
    const t = a.totals
    lines.push([a.startedAt.slice(0, 19).replace('T', ' '), a.status.padEnd(11), a.workflow.padEnd(width), String(t.steps).padStart(5), formatMs(t.durationMs).padStart(8), num(t.calls).padStart(6), num(t.totalTokens).padStart(11), formatCost(t.costUsd).padStart(9), a.runId.slice(0, 8)].join('  '))
  }
  return lines.join('\n')
}

export { formatTokens }
