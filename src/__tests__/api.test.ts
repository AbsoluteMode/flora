import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiAdapter } from '../adapters/api'
import { setTimeout as pause } from 'node:timers/promises'
import { doctor } from '../doctor'
import { loadProviders, resolveProvider } from '../providers'
import { RunStore } from '../state'
import { validateWorkflow, WorkflowError } from '../workflow'
import type { RunRecord, WorkflowSpec } from '../types'

const run = promisify(execFile)
const BIN = join(process.cwd(), 'bin', 'flora.mjs')
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

let dir: string
let home: string
let server: Server
let base: string
const requests: Array<{ auth?: string; body: Record<string, unknown> }> = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flora-api-'))
  home = join(dir, 'home')
  mkdirSync(home)
  requests.length = 0
  // A fake OpenAI-compatible endpoint: echoes a JSON answer, prices the call like OpenRouter does.
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push({ auth: req.headers.authorization, body })
      if (req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'no such key' } }))
      }
      if (body.model === 'busy' || (body.model === 'flaky' && requests.length < 2)) {
        res.writeHead(503, { 'content-type': 'text/plain' })
        return res.end('busy')
      }
      if (body.model === 'slow') await pause(50)
      if (body.model === 'partial') { res.writeHead(200); res.write('{'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { role: 'assistant', content: 'Sure.\n\n```json\n{"verdict": "pass", "score": 0.8}\n```' } }],
          usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138, cost: 0.0042 }
        })
      )
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const address = server.address() as { port: number }
  base = `http://127.0.0.1:${address.port}/v1`
  writeFileSync(join(home, 'providers.yaml'), `fake:\n  base_url: ${base}\n  api_key_env: FAKE_API_KEY\n  cost_in_usage: true\nkeyless:\n  base_url: ${base}\n  api_key_env: none\n`)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await new Promise<void>((ok) => server.close(() => ok()))
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const flora = (args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, [BIN, ...args], { cwd: dir, env: { ...process.env, FLORA_HOME: home, FLORA_DB: join(home, 'flora.db'), ...env } }).then((r) => ({ ...r, stdout: plain(r.stdout) }))

describe('providers', () => {
  it('reads providers.yaml, and explains what is missing', () => {
    const providers = loadProviders(join(home, 'providers.yaml'))
    expect(Object.keys(providers)).toEqual(['fake', 'keyless'])
    expect(providers.fake).toMatchObject({ base_url: base, api_key_env: 'FAKE_API_KEY', cost_in_usage: true })
    expect(resolveProvider('fake', { FAKE_API_KEY: 'k' }, join(home, 'providers.yaml')).apiKey).toBe('k')
    expect(resolveProvider('keyless', {}, join(home, 'providers.yaml')).apiKey).toBeUndefined()
    expect(() => resolveProvider('fake', {}, join(home, 'providers.yaml'))).toThrow(/FAKE_API_KEY is not set/)
    expect(() => resolveProvider('nope', {}, join(home, 'providers.yaml'))).toThrow(/configured: fake, keyless/)
    expect(() => resolveProvider('any', {}, join(dir, 'absent.yaml'))).toThrow(/no model API providers are configured/)
    writeFileSync(join(dir, 'bad.yaml'), 'x:\n  base_url: ftp://nope\n  api_key_env: K\n')
    expect(() => loadProviders(join(dir, 'bad.yaml'))).toThrow(/base_url must be an http\(s\) URL/)
  })

  it('the validator wants a provider and refuses tools on an api step', () => {
    const spec = (executor: Record<string, unknown>, extra: Record<string, unknown> = {}): WorkflowSpec =>
      ({ name: 'w', steps: [{ id: 'judge', executor, prompt: 'judge this', ...extra }] }) as unknown as WorkflowSpec
    expect(() => validateWorkflow(spec({ harness: 'api' }))).toThrow(/executor.provider/)
    expect(() => validateWorkflow(spec({ harness: 'api', provider: 'fake', temperature: 'hot' }))).toThrow(/temperature/)
    expect(() => validateWorkflow(spec({ harness: 'api', provider: 'fake' }, { tools: [{ flora: 'read_context' }] }))).toThrow(WorkflowError)
    expect(() => validateWorkflow(spec({ harness: 'api', provider: 'fake', model: 'm', temperature: 0, max_tokens: 400 }))).not.toThrow()
  })
})

describe('api harness', () => {
  it('honors timeout_min: 0 and a single deadline across retry backoff', async () => {
    vi.stubEnv('FLORA_HOME', home)
    vi.stubEnv('FAKE_API_KEY', 'test-key')
    const noLimit = await apiAdapter.execute({ spec: { harness: 'api', provider: 'fake', model: 'slow', timeout_min: 0 }, prompt: 'hello', cwd: dir })
    expect(noLimit.exitCode).toBe(0)
    const started = Date.now()
    const limited = await apiAdapter.execute({ spec: { harness: 'api', provider: 'fake', model: 'busy', timeout_min: 0.002 }, prompt: 'hello', cwd: dir })
    expect(limited.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
    const partial = await apiAdapter.execute({ spec: { harness: 'api', provider: 'fake', model: 'partial', timeout_min: 0.002 }, prompt: 'hello', cwd: dir })
    expect(partial.timedOut).toBe(true)
  })

  it('cancels a retry backoff promptly', async () => {
    vi.stubEnv('FLORA_HOME', home)
    vi.stubEnv('FAKE_API_KEY', 'test-key')
    const abort = new AbortController()
    const running = apiAdapter.execute({ spec: { harness: 'api', provider: 'fake', model: 'busy' }, prompt: 'hello', cwd: dir, signal: abort.signal })
    while (!requests.length) await pause(10)
    const started = Date.now()
    abort.abort()
    expect((await running).output).toMatch(/aborted/)
    expect(Date.now() - started).toBeLessThan(1000)
  })
  it('sends the prompt, records the answer, tokens and price; the key never leaves the environment', { timeout: 60_000 }, async () => {
    const workflow = join(dir, 'judge.yaml')
    writeFileSync(
      workflow,
      `name: judge
params:
  text: { required: true }
steps:
  - id: judge
    executor: { harness: api, provider: fake, model: test-model, temperature: 0 }
    prompt: "Rate this: {{text}}"
    output: { type: json, schema: { type: object, required: [verdict] } }
`
    )
    const { stdout } = await flora(['run', workflow, '--cwd', dir, '--param', 'text=banana coffee'], { FAKE_API_KEY: 'test-key' })
    expect(stdout).toContain('run passed')
    expect(requests).toHaveLength(1)
    expect(requests[0].auth).toBe('Bearer test-key')
    expect(requests[0].body).toMatchObject({ model: 'test-model', temperature: 0, usage: { include: true } })
    expect(JSON.stringify(requests[0].body.messages)).toContain('Rate this: banana coffee')

    const store = new RunStore(join(home, 'flora.db'))
    const record = store.list(1).map((r) => store.load(r.runId))[0] as RunRecord
    store.close()
    const step = record.steps[0]
    expect(step.harness).toBe('api')
    expect(step.prompt).toBe('Rate this: banana coffee')
    expect(step.output).toEqual({ verdict: 'pass', score: 0.8 })
    expect(step.evidence).toMatchObject({ exitCode: 0, costUsd: 0.0042, usage: { inputTokens: 120, outputTokens: 18, totalTokens: 138 } })
    expect(JSON.stringify(record)).not.toContain('test-key')

    const { stdout: usage } = await flora(['usage'])
    expect(usage).toMatch(/judge\s+1\s+–\s+120\s+18\s+138\s+\$0\.0042/)
  })

  it('a wrong key fails the step with the provider’s words; a busy provider is retried', { timeout: 60_000 }, async () => {
    const workflow = join(dir, 'judge.yaml')
    writeFileSync(workflow, `name: judge\nsteps:\n  - id: judge\n    executor: { harness: api, provider: fake, model: test-model }\n    prompt: hi\n`)
    await expect(flora(['run', workflow, '--cwd', dir], { FAKE_API_KEY: 'wrong' })).rejects.toMatchObject({ stdout: expect.stringContaining('run failed') })
    const store = new RunStore(join(home, 'flora.db'))
    const failedRun = store.list(1).map((r) => store.load(r.runId))[0] as RunRecord
    expect(failedRun.steps[0].evidence?.output).toContain('no such key')
    store.close()

    requests.length = 0
    writeFileSync(workflow, `name: judge\nsteps:\n  - id: judge\n    executor: { harness: api, provider: fake, model: flaky }\n    prompt: hi\n`)
    const { stdout } = await flora(['run', workflow, '--cwd', dir], { FAKE_API_KEY: 'test-key' })
    expect(stdout).toContain('run passed')
    expect(requests.length).toBe(2)

    await expect(flora(['run', workflow, '--cwd', dir], {})).rejects.toMatchObject({ stdout: expect.stringContaining('FAKE_API_KEY is not set') })
  })

  it('flora doctor lists the configured providers and whether their keys are set', async () => {
    const probes = await doctor({ FAKE_API_KEY: 'k', FLORA_HOME: home })
    const lines = probes.filter((p) => p.name.startsWith('provider'))
    expect(lines.map((p) => [p.name, p.ok])).toEqual([
      ['provider fake', true],
      ['provider keyless', true]
    ])
    const missing = (await doctor({ FLORA_HOME: home })).find((p) => p.name === 'provider fake')
    expect(missing?.ok).toBe(false)
    expect(missing?.hint).toContain('FAKE_API_KEY')
  })
})
