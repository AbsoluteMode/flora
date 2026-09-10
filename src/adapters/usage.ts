import type { Evidence, Usage } from '../types'

/**
 * Token accounting, read from whatever a harness printed.
 *
 * Two passes. First the transcript is scanned line by line for JSON carrying a
 * usage object — Codex (`turn.completed`), Claude Code (`result`), and the
 * provider dialects underneath them (OpenAI `prompt_tokens`, Anthropic
 * `input_tokens` + cache fields, Gemini `promptTokenCount`). The last one wins:
 * it belongs to the final turn. Then the tail of the text is searched for
 * summary lines (`tokens used: 12,345`, `input=1200 output=340`, `42% of
 * weekly limit`). JSON beats text field by field.
 *
 * Cache semantics differ by dialect and are normalised here: Anthropic counts
 * cache reads *outside* `input_tokens`, OpenAI/Codex and Gemini count them
 * *inside*. `contextTokens` is always the prompt-side total.
 */
export function parseUsage(output: string): Usage | undefined {
  const fromJson = lastJsonUsage(output)
  const fromText = textUsage(output.slice(-TEXT_WINDOW))
  if (!fromJson && !fromText) return undefined

  const usage: Usage = { ...fromText }
  for (const [key, value] of Object.entries(fromJson ?? {})) {
    if (value !== undefined) usage[key as keyof Usage] = value as number
  }
  if (usage.totalTokens === undefined && usage.contextTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.contextTokens + usage.outputTokens
  }
  for (const key of Object.keys(usage) as Array<keyof Usage>) {
    if (!Number.isFinite(usage[key])) delete usage[key]
  }
  return Object.keys(usage).length ? usage : undefined
}

/** Only the tail of a transcript is scanned for text summaries: they come last. */
const TEXT_WINDOW = 8000

type Raw = Record<string, unknown>

/** Where a usage object hides inside one JSON line, by convention. */
const USAGE_KEYS = ['usage', 'usageMetadata', 'token_usage', 'tokenUsage', 'tokens']

/** Field spellings across CLIs and provider APIs. First match wins. */
const INPUT = ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens', 'promptTokenCount', 'input', 'prompt']
const OUTPUT = ['output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens', 'candidatesTokenCount', 'output', 'completion']
/** Cache reads that are *not* part of the input figure (Anthropic). */
const CACHE_APART = ['cache_read_input_tokens', 'cacheReadInputTokens']
const CACHE_WRITE = ['cache_creation_input_tokens', 'cacheCreationInputTokens']
/** Cache reads already counted inside the input figure (OpenAI, Codex, Gemini). */
const CACHE_INSIDE = ['cached_input_tokens', 'cachedInputTokens', 'cached_tokens', 'cachedTokens', 'cachedContentTokenCount', 'cached']
const TOTAL = ['total_tokens', 'totalTokens', 'totalTokenCount', 'total']
const LIMIT = ['limit_pct', 'limitPct', 'quota_pct', 'quotaPct', 'usage_pct']
/** Model calls a tool counted (a script fanning out over an API); not Claude Code's num_turns. */
const CALLS = ['calls', 'model_calls', 'api_calls', 'requests', 'num_calls']
/** Money: inside the usage object (OpenRouter `usage.cost`) or next to it (Claude Code `total_cost_usd`). */
const COST = ['cost_usd', 'costUsd', 'total_cost_usd', 'totalCostUsd', 'cost']

/**
 * The usage a transcript reports, attached to the evidence: tokens under
 * `usage`, money under `costUsd` when the tool priced its own work. The base
 * for every adapter whose harness prints a summary rather than a stream.
 */
export function attachUsage(evidence: Evidence): Evidence {
  const usage = parseUsage(evidence.output)
  if (!usage) return evidence
  const costUsd = evidence.costUsd ?? usage.costUsd
  return { ...evidence, usage, ...(costUsd !== undefined ? { costUsd } : {}) }
}

function lastJsonUsage(output: string): Usage | undefined {
  let found: Usage | undefined
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let frame: Raw
    try {
      frame = JSON.parse(trimmed) as Raw
    } catch {
      continue
    }
    const raw = findUsageObject(frame)
    if (!raw) continue
    const parsed = normalise(raw)
    if (!parsed) continue
    // Claude Code prices the whole result next to `usage`, not inside it.
    if (parsed.costUsd === undefined && raw !== frame) parsed.costUsd = pickMoney(frame, COST)
    found = parsed
  }
  return found
}

/** A price is a float; the token pickers only trust integers. */
function pickMoney(raw: Raw, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^\$?\d+(?:\.\d+)?$/.test(value)) return Number(value.replace('$', ''))
  }
  return undefined
}

function findUsageObject(frame: Raw): Raw | null {
  // Iterative depth-first traversal: transcripts can contain deeply nested tool data.
  const pending = [frame]
  while (pending.length) {
    const current = pending.pop()!
    for (const key of USAGE_KEYS) {
      const candidate = current[key]
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate as Raw
    }
    if (pick(current, INPUT) !== undefined || pick(current, TOTAL) !== undefined) return current
    const children = Object.values(current).filter((v): v is Raw => Boolean(v) && typeof v === 'object' && !Array.isArray(v))
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i])
  }
  return null
}

function pick(raw: Raw, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^[\d,_]+$/.test(value)) return toNumber(value)
    // OpenAI nests cache under prompt_tokens_details.
    if (key === 'cached_tokens') {
      const details = raw.prompt_tokens_details as Raw | undefined
      if (details && typeof details.cached_tokens === 'number') return details.cached_tokens
    }
  }
  return undefined
}

function normalise(raw: Raw): Usage | undefined {
  const input = pick(raw, INPUT)
  const output = pick(raw, OUTPUT)
  const cacheApart = pick(raw, CACHE_APART)
  const cacheWrite = pick(raw, CACHE_WRITE)
  const cacheInside = pick(raw, CACHE_INSIDE)
  const total = pick(raw, TOTAL)
  const limit = pick(raw, LIMIT)
  const calls = pick(raw, CALLS)
  const costUsd = pickMoney(raw, COST)
  if ([input, output, cacheApart, cacheWrite, cacheInside, total, limit, calls, costUsd].every((v) => v === undefined)) return undefined

  const cached = cacheApart ?? cacheInside
  const context =
    input === undefined
      ? undefined
      : cacheApart !== undefined || cacheWrite !== undefined
        ? input + (cacheApart ?? 0) + (cacheWrite ?? 0)
        : input

  return {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    contextTokens: context,
    totalTokens: total,
    limitPct: limit,
    calls,
    costUsd
  }
}

// ── text summaries ─────────────────────────────────────────────────────────

const toNumber = (text: string): number => Number(text.replace(/[,_]/g, ''))

/**
 * `label: 1,234` / `label=1234` / `1,234 label tokens`. The lookahead refuses
 * a number that continues after whitespace ("7 890" is not a count of seven).
 */
function labelled(tail: string, label: string): number | undefined {
  const value = `([\\d][\\d,_]*)(?!\\s*\\d)`
  const patterns = [
    new RegExp(`\\b(?:${label})(?:[_\\s-]?tokens)?\\s*[=:]\\s*${value}`, 'i'),
    new RegExp(`\\b${value}\\s+(?:${label})\\s+tokens\\b`, 'i')
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(tail)
    if (match) return toNumber(match[1])
  }
  return undefined
}

function textUsage(tail: string): Usage | undefined {
  const usage: Usage = {
    inputTokens: labelled(tail, 'input|prompt'),
    outputTokens: labelled(tail, 'output|completion'),
    cachedTokens: labelled(tail, 'cached?(?:[_\\s-]?input)?'),
    contextTokens: labelled(tail, 'context'),
    totalTokens: labelled(tail, 'tokens?\\s+used|total') ?? trailingTotal(tail)
  }

  const limit =
    /\b(?:limit|quota)\b[^\d%\n]{0,24}?([\d.]+)\s*%/i.exec(tail) ??
    /([\d.]+)\s*%\s*(?:of\s+)?(?:\w+\s+){0,3}?(?:limit|quota)\b/i.exec(tail)
  if (limit) usage.limitPct = Number(limit[1])
  // `cost: $0.42` / `cost=0.42` / `$0.42 spent`.
  const cost = /\bcost\b[^\d\n$]{0,12}\$?\s*(\d+(?:\.\d+)?)/i.exec(tail) ?? /\$(\d+(?:\.\d+)?)\s+(?:spent|total)\b/i.exec(tail)
  if (cost) usage.costUsd = Number(cost[1])
  const calls = /\b(\d[\d,_]*)\s+(?:model\s+|api\s+)?calls\b/i.exec(tail) ?? /\bcalls\s*[=:]\s*(\d[\d,_]*)/i.exec(tail)
  if (calls) usage.calls = toNumber(calls[1])

  if (usage.inputTokens !== undefined && usage.contextTokens === undefined) {
    usage.contextTokens = usage.inputTokens
  }
  for (const key of Object.keys(usage) as Array<keyof Usage>) {
    if (!Number.isFinite(usage[key])) delete usage[key]
  }
  return Object.keys(usage).length ? usage : undefined
}

/** `12,345 tokens used` — number first. */
function trailingTotal(tail: string): number | undefined {
  const match = /\b([\d][\d,_]*)\s+tokens?\s+used\b/i.exec(tail)
  return match ? toNumber(match[1]) : undefined
}
