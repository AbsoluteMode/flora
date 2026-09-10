import { createHash } from 'node:crypto'
import { runCommand } from './adapters/command'
import type { CommandSource, SentrySource } from './types'

/**
 * What a trigger hands the run. `id` is the dedup fingerprint; the rest is a
 * flat payload reachable as `{{event.*}}` and `$FLORA_CONTEXT.event`.
 */
export interface TriggerEvent {
  source: 'cron' | 'sentry' | 'command'
  id: string
  at: string
  [key: string]: unknown
}

/** Poll errors back off exponentially from the source's interval up to a ceiling. */
export const MAX_BACKOFF_MS = 15 * 60_000

export function backoffMs(intervalMs: number, failures: number): number {
  return Math.min(intervalMs * 2 ** Math.max(0, failures), MAX_BACKOFF_MS)
}

export function cronEvent(schedule: string, at: Date): TriggerEvent {
  return { source: 'cron', id: at.toISOString().slice(0, 16), at: at.toISOString(), schedule }
}

interface SentryIssue {
  id: string
  title?: string
  culprit?: string
  permalink?: string
  level?: string
  count?: string | number
  firstSeen?: string
  lastSeen?: string
}

/**
 * Sentry's issues list for one project. The token comes from the environment
 * only — a workflow file never carries a secret. `url` overrides the API host
 * for self-hosted installs (and for tests).
 */
export async function pollSentry(source: SentrySource, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<TriggerEvent[]> {
  const token = process.env.SENTRY_AUTH_TOKEN
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set')

  const url = new URL(
    `/api/0/projects/${encodeURIComponent(source.org)}/${encodeURIComponent(source.project)}/issues/`,
    source.url ?? 'https://sentry.io'
  )
  if (source.query) url.searchParams.set('query', source.query)

  const timeout = AbortSignal.timeout(60_000)
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } })
  if (!response.ok) throw new Error(`sentry answered ${response.status} for ${url.pathname}`)
  const issues = (await response.json()) as SentryIssue[]
  if (!Array.isArray(issues)) throw new Error('sentry answered with something that is not an issue list')

  const pattern = source.match ? new RegExp(source.match) : null
  const at = new Date().toISOString()
  return issues
    .filter((issue) => !pattern || pattern.test(`${issue.title ?? ''} ${issue.culprit ?? ''}`))
    .map((issue) => ({
      source: 'sentry' as const,
      id: String(issue.id),
      at,
      title: issue.title,
      message: issue.title,
      culprit: issue.culprit,
      url: issue.permalink,
      level: issue.level,
      count: issue.count === undefined ? undefined : Number(issue.count),
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen
    }))
}

/**
 * Anything that can print: an empty stdout is silence, a JSON object per line
 * is one event each, plain text is a single event carrying it. The command
 * runs through the same runner as a step, so stall/timeout apply.
 */
export async function pollCommand(source: CommandSource, cwd: string, signal?: AbortSignal): Promise<TriggerEvent[]> {
  const evidence = await runCommand(
    source.run,
    [],
    { cwd, signal, timeoutMin: source.timeout_min ?? 5, stallMin: 0 },
    { shell: true }
  )
  if (evidence.exitCode !== 0) {
    throw new Error(`command source exited ${evidence.exitCode ?? 'without a code'}: ${evidence.output.slice(-300)}`)
  }
  const text = evidence.output.trim()
  if (!text) return []

  const at = new Date().toISOString()
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const parsed = lines.map((line) => {
    try {
      const value = JSON.parse(line) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  })
  if (parsed.every((v) => v !== null)) {
    return parsed.map((value, i) => ({
      ...value,
      source: 'command' as const,
      id: value!.id !== undefined ? String(value!.id) : fingerprint(lines[i]),
      at
    }))
  }
  return [{ source: 'command', id: fingerprint(text), at, text }]
}

export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}
