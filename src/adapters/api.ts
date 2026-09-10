import type { Evidence } from '../types'
import type { HarnessAdapter } from './types'
import { withOutputInstruction } from '../output'
import { resolveProvider } from '../providers'
import { parseUsage } from './usage'
import { setTimeout as pause } from 'node:timers/promises'

/**
 * The `api` harness: one prompt → one completion from a configured model
 * API, no tools, no repo access. For the steps of a pipeline that are pure
 * judgement — classify, extract, score — where a coding harness would be
 * the wrong tool and a script the wrong place for the prompt. The provider
 * is named in the step and configured on the machine (`providers.yaml`);
 * an API is always an explicit choice, never a default.
 *
 * The transcript is the answer text; tokens come from the usual `usage`
 * object and, where the provider prices the call (OpenRouter), so does the
 * cost. 429 and 5xx are retried a few times with a pause.
 */
const DEFAULT_TIMEOUT_MIN = 15
const RETRIES = 3

export const apiAdapter: HarnessAdapter = {
  name: 'api',
  async execute(input): Promise<Evidence> {
    const started = Date.now()
    const spec = input.spec
    const providerName = spec.provider
    if (!providerName) return failed('api harness: the step names no provider (executor.provider)', started)
    let provider
    try {
      provider = resolveProvider(providerName)
    } catch (err) {
      return failed((err as Error).message, started)
    }
    const model = spec.model ?? provider.default_model
    if (!model) return failed(`api harness: no model — set executor.model or default_model on provider "${providerName}"`, started)

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: 'You are one step of a flora workflow. Do the task in the message and answer with the result only.' },
        { role: 'user', content: withOutputInstruction(input.prompt ?? '', input.output) }
      ],
      ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
      ...(spec.max_tokens !== undefined ? { max_tokens: spec.max_tokens } : {}),
      ...(provider.cost_in_usage ? { usage: { include: true } } : {})
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      ...(provider.headers ?? {})
    }
    const timeoutMin = spec.timeout_min ?? DEFAULT_TIMEOUT_MIN
    const timeout = timeoutMin > 0 ? AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMin * 60_000))) : undefined
    const signals = [input.signal, timeout].filter((s): s is AbortSignal => s !== undefined)
    const signal = signals.length ? AbortSignal.any(signals) : undefined
    const stopped = (): Evidence => ({
      ...failed(input.signal?.aborted ? 'aborted' : `provider "${providerName}": wall-clock limit exceeded`, started),
      ...(!input.signal?.aborted && timeout?.aborted ? { timedOut: true } : {})
    })
    const backoff = async (ms: number): Promise<boolean> => {
      try { await pause(ms, undefined, { signal }); return true }
      catch (err) { if (signal?.aborted) return false; throw err }
    }

    let lastError = ''
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      if (signal?.aborted) return stopped()
      let res: Response
      let text: string
      try {
        res = await fetch(`${provider.base_url}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal
        })
        text = await res.text()
      } catch (err) {
        if (signal?.aborted) return stopped()
        lastError = `provider "${providerName}": ${(err as Error).message}`
        if (attempt < RETRIES && !(await backoff(2000 * attempt))) return stopped()
        continue
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = `provider "${providerName}" answered ${res.status}: ${text.slice(0, 300)}`
        if (attempt < RETRIES && !(await backoff(3000 * attempt))) return stopped()
        continue
      }
      if (!res.ok) return failed(`provider "${providerName}" answered ${res.status}: ${text.slice(0, 500)}`, started)
      let parsed: { choices?: Array<{ message?: { content?: string | null } }>; usage?: unknown; model?: string; error?: { message?: string } }
      try {
        parsed = JSON.parse(text)
      } catch {
        return failed(`provider "${providerName}" did not answer with JSON: ${text.slice(0, 300)}`, started)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failed(`provider "${providerName}" did not return a text completion`, started)
      if (parsed.error?.message) return failed(`provider "${providerName}": ${parsed.error.message}`, started)
      const answer = parsed.choices?.[0]?.message?.content
      if (typeof answer !== 'string') return failed(`provider "${providerName}" did not return a text completion`, started)
      input.onOutput?.(answer)
      const usage = parseUsage(JSON.stringify({ usage: parsed.usage ?? {} }))
      return {
        output: answer,
        exitCode: 0,
        durationMs: Date.now() - started,
        ...(usage ? { usage } : {}),
        ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {})
      }
    }
    return failed(lastError || `provider "${providerName}": gave up after ${RETRIES} attempts`, started)
  }
}

function failed(message: string, started: number): Evidence {
  return { output: message, exitCode: 1, durationMs: Date.now() - started }
}
