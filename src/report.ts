import type { CheckResult, RunRecord, StepResult } from './types'
import { analyticsMarkdown, mermaidFlow, runAnalytics } from './analytics'
import { formatCost, formatTokens, runUsage } from './usage'
import { codeFence, codeSpan, markdownText as text } from './markdown'

/**
 * A run as a document: what ran, what each step produced, what the verifier
 * decided, what it all cost. Markdown, because it is read by people, travels
 * through chats and mail, and diffs. The journal stays the source of truth;
 * this is the copy you hand over.
 */
const OUTPUT_TAIL = 16 * 1024

export function renderRunReport(record: RunRecord, options: { version?: string } = {}): string {
  const lines: string[] = []
  const duration = record.finishedAt ? formatMs(Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : 'still running'
  lines.push(`# ${text(record.workflow)} — ${record.status}`, '')
  lines.push(`| | |`, `|---|---|`)
  lines.push(`| Run | ${codeSpan(record.runId)} |`)
  lines.push(`| Started | ${text(record.startedAt)} |`)
  lines.push(`| Finished | ${text(record.finishedAt ?? '—')} (${duration}) |`)
  lines.push(`| Directory | ${codeSpan(record.cwd)} |`)
  if (record.trigger) lines.push(`| Trigger | ${text(record.trigger.source)} · ${text(record.trigger.id)} |`)
  if (record.parentRunId) lines.push(`| Parent run | ${codeSpan(record.parentRunId)} |`)
  const params = Object.entries(record.params ?? {})
  if (params.length) lines.push(`| Parameters | ${params.map(([k, v]) => codeSpan(`${k}=${v}`)).join(' ')} |`)
  lines.push('')

  const failed = record.steps.find((s) => s.status === 'failed')
  if (failed) lines.push(`Stopped at **${text(failed.stepId)}**${failed.error ? `: ${text(failed.error)}` : ''}.`, '')

  const usage = runUsage(record)
  if (usage.total.reported) {
    lines.push('## Usage', '')
    lines.push('| step | attempts | calls | input | output | total | cost |', '|---|---:|---:|---:|---:|---:|---:|')
    for (const s of usage.steps.filter((x) => x.status !== 'skipped')) {
      lines.push(`| ${text(s.stepId)} | ${s.attempts || '–'} | ${formatTokens(s.calls)} | ${formatTokens(s.inputTokens)} | ${formatTokens(s.outputTokens)} | ${formatTokens(s.totalTokens)} | ${formatCost(s.costUsd)} |`)
    }
    const t = usage.total
    lines.push(`| **total** | ${t.attempts} | ${formatTokens(t.calls)} | ${formatTokens(t.inputTokens)} | ${formatTokens(t.outputTokens)} | ${formatTokens(t.totalTokens)} | ${formatCost(t.costUsd)} |`, '')
  }

  const analytics = runAnalytics(record)
  if (analytics.edges.length || analytics.steps.some((s) => Object.keys(s.metrics).length || s.outputBytes !== undefined)) {
    lines.push('## Analytics', '', ...analyticsMarkdown(analytics), '')
    if (analytics.edges.length) lines.push(...codeFence(mermaidFlow(analytics), 'mermaid'), '')
  }

  lines.push('## Steps', '')
  for (const step of record.steps) lines.push(...renderStep(step, 3))

  lines.push('---', '', `_${options.version ? `flora ${text(options.version)}` : 'flora'} · run report · journal record ${codeSpan(record.runId)}_`, '')
  return lines.join('\n')
}

function renderStep(step: StepResult, level: number): string[] {
  const h = '#'.repeat(level)
  const lines: string[] = []
  const mark = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'skipped' ? '–' : '…'
  lines.push(`${h} ${mark} ${text(step.stepId)}${step.title ? ` — ${text(step.title)}` : ''}`, '')
  const facts: string[] = [`status **${step.status}**`]
  if (step.harness) facts.push(`executor ${text(step.harness)}`)
  if (step.attempt > 1) facts.push(`attempt ${step.attempt} (retried)`)
  const e = step.evidence
  if (e) {
    facts.push(`took ${formatMs(e.durationMs)}`)
    facts.push(`exit ${e.exitCode === null || e.exitCode === undefined ? 'none' : e.exitCode}`)
    if (e.stalled) facts.push('stalled')
    if (e.timedOut) facts.push('timed out')
    if (e.costUsd !== undefined) facts.push(`cost ${formatCost(e.costUsd)}`)
    if (e.usage?.inputTokens !== undefined || e.usage?.totalTokens !== undefined) {
      facts.push(`tokens ${e.usage.inputTokens !== undefined ? `${formatTokens(e.usage.inputTokens)} → ${formatTokens(e.usage.outputTokens ?? 0)}` : formatTokens(e.usage.totalTokens)}`)
    }
  }
  if (step.verifiedIn === 'worktree') facts.push('verified in a worktree of HEAD')
  lines.push(facts.join(' · '), '')
  if (step.skipReason) lines.push(`Skipped — when: ${codeSpan(step.skipReason)}`, '')
  if (step.outputError) lines.push(`Output contract: ${text(step.outputError)}`, '')
  if (step.error) lines.push(`Error: ${text(step.error)}`, '')
  if (step.priorAttempts?.length) {
    lines.push(`Earlier attempts: ${step.priorAttempts.map((a) => `#${a.attempt} ${a.status}${a.evidence ? ` (${formatMs(a.evidence.durationMs)}${a.evidence.costUsd !== undefined ? `, ${formatCost(a.evidence.costUsd)}` : ''})` : ''}`).join(', ')}`, '')
  }
  if (step.prompt) lines.push('Prompt (as sent):', '', ...codeFence(step.prompt, 'text'), '')
  if (step.command) lines.push('Command (as run):', '', ...codeFence(step.command, 'sh'), '')
  if (step.artifacts?.length) {
    lines.push(`Artifacts (${step.artifacts.length}, ${formatBytes(step.artifacts.reduce((s, a) => s + a.bytes, 0))}):`, '')
    for (const a of step.artifacts.slice(0, 50)) lines.push(`- ${codeSpan(a.path)} (${formatBytes(a.bytes)})`)
    if (step.artifacts.length > 50) lines.push(`- … and ${step.artifacts.length - 50} more`)
    lines.push('')
  }
  if (step.checks.length) {
    lines.push('Checks:', '')
    for (const c of step.checks) lines.push(`- ${c.passed ? '✓' : '✗'} ${describeCheck(c)}${c.detail ? ` — ${text(c.detail)}` : ''}`)
    lines.push('')
  }
  if (step.output !== undefined && step.output !== null) {
    lines.push('Output:', '', ...codeFence(typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2), 'json'), '')
  }
  if (step.branches?.length) {
    for (const branch of step.branches) lines.push(...renderStep(branch, Math.min(level + 1, 6)))
  } else if (e?.output) {
    const text = e.output.length > OUTPUT_TAIL ? `… (${formatBytes(e.output.length - OUTPUT_TAIL)} earlier omitted)\n${e.output.slice(-OUTPUT_TAIL)}` : e.output
    lines.push('<details><summary>Executor output</summary>', '', ...codeFence(text, 'text'), '', '</details>', '')
  }
  return lines
}

function describeCheck(c: CheckResult): string {
  const spec = c.check
  if (!spec) return text(c.detail ?? 'check')
  if (spec.type === 'artifact') return `artifact ${text(spec.path ?? '')}${spec.contains ? ` contains "${text(spec.contains)}"` : ''}`.trim()
  return `${codeSpan(spec.run ?? '')}${spec.expect_exit !== undefined ? ` (exit ${spec.expect_exit})` : ''}${spec.expect_match ? ` matches "${text(spec.expect_match)}"` : ''}`
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`
}
