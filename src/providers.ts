import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { floraHome } from './paths'
import { WorkflowError } from './workflow'

/**
 * Model API providers for the `api` harness — configured once, on the
 * machine, never in a pipeline. A pipeline names a provider
 * (`executor: { harness: api, provider: openrouter, model: … }`); the
 * provider says where to send the request and which environment variable
 * holds the key. No providers file, no API: the local harnesses are the
 * default and an API is an explicit choice.
 *
 *   # ~/.flora/providers.yaml
 *   openrouter:
 *     base_url: https://openrouter.ai/api/v1
 *     api_key_env: OPENROUTER_API_KEY
 *     cost_in_usage: true          # OpenRouter prices the call in usage.cost
 *   local:
 *     base_url: http://127.0.0.1:11434/v1
 *     api_key_env: none            # no key needed
 *
 * Every provider speaks the OpenAI chat-completions dialect (OpenRouter,
 * OpenAI, Ollama, LM Studio, vLLM, …).
 */
export interface ProviderSpec {
  name: string
  base_url: string
  /** Environment variable holding the key; `none` for a server that needs none. */
  api_key_env: string
  /** Ask for the price in the response (OpenRouter's `usage: { include: true }`). */
  cost_in_usage?: boolean
  /** Extra headers, e.g. OpenRouter's attribution headers. */
  headers?: Record<string, string>
  /** Used when a step names no model. */
  default_model?: string
}

export function providersPath(): string {
  return join(floraHome(), 'providers.yaml')
}

export function loadProviders(path = providersPath()): Record<string, ProviderSpec> {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new WorkflowError(`${path}: not valid YAML — ${(err as Error).message}`)
  }
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new WorkflowError(`${path}: expected a mapping of provider name → settings`)
  const out: Record<string, ProviderSpec> = Object.create(null)
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError(`${path}: provider "${name}" must be a mapping`)
    const v = value as Record<string, unknown>
    for (const key of Object.keys(v)) {
      if (!['base_url', 'api_key_env', 'cost_in_usage', 'headers', 'default_model'].includes(key)) throw new WorkflowError(`${path}: provider "${name}": unknown field "${key}"`)
    }
    if (typeof v.base_url !== 'string' || !/^https?:\/\//.test(v.base_url)) throw new WorkflowError(`${path}: provider "${name}": base_url must be an http(s) URL`)
    if (typeof v.api_key_env !== 'string' || !v.api_key_env) throw new WorkflowError(`${path}: provider "${name}": api_key_env is required (the name of the environment variable, or "none")`)
    out[name] = {
      name,
      base_url: v.base_url.replace(/\/+$/, ''),
      api_key_env: v.api_key_env,
      ...(v.cost_in_usage !== undefined ? { cost_in_usage: Boolean(v.cost_in_usage) } : {}),
      ...(v.headers && typeof v.headers === 'object' ? { headers: Object.fromEntries(Object.entries(v.headers as Record<string, unknown>).map(([k, h]) => [k, String(h)])) } : {}),
      ...(typeof v.default_model === 'string' ? { default_model: v.default_model } : {})
    }
  }
  return out
}

export interface ResolvedProvider extends ProviderSpec {
  /** The key from the environment, or undefined when the provider needs none. */
  apiKey?: string
}

/** The provider a step named, with its key from the environment — or a sentence on what to set up. */
export function resolveProvider(name: string, env: NodeJS.ProcessEnv = process.env, path = providersPath()): ResolvedProvider {
  const providers = loadProviders(path)
  const spec = providers[name]
  if (!spec) {
    const known = Object.keys(providers)
    throw new WorkflowError(
      known.length
        ? `provider "${name}" is not configured in ${path} (configured: ${known.join(', ')})`
        : `no model API providers are configured — the api harness needs ${path} with, for example:\n  openrouter:\n    base_url: https://openrouter.ai/api/v1\n    api_key_env: OPENROUTER_API_KEY\n    cost_in_usage: true`
    )
  }
  if (spec.api_key_env === 'none') return { ...spec }
  const apiKey = env[spec.api_key_env]
  if (!apiKey) throw new WorkflowError(`provider "${name}": the environment variable ${spec.api_key_env} is not set — the key never lives in the pipeline, only in the environment`)
  return { ...spec, apiKey }
}
