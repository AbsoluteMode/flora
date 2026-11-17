import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  ANTIGRAVITY_SETTINGS,
  antigravityAdapter,
  antigravityModel,
  findAgy,
  parseAntigravityModels,
  parseAntigravityStream
} from '../adapters/antigravity'
import { adapterFor } from '../adapters'
import { schemaErrors } from '../contract'
import { explainFailure, interpretAntigravity } from '../doctor'
import { validateWorkflow, WorkflowError } from '../workflow'
import type { Evidence, ExecutorSpec, WorkflowSpec } from '../types'

const MODELS = [
  'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)',
  'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
  'gemini-pro-orchestrator\tOrchestrator (Carbon)'
].join('\n')

/**
 * A stand-in `agy`: `--version` and `models` answer like agy 1.5.9 (the
 * "Fetching…" banner on stderr), a print run records its argv and cwd and then
 * behaves as $AGY_SCENARIO says. Never the real CLI.
 */
const FIXTURE = `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.5.9'); process.exit(0) }
if (args[0] === 'models') {
  if (process.env.AGY_SCENARIO === 'models-fail') { console.error('Fetching available models...'); console.error('not signed in'); process.exit(2) }
  console.error('Fetching available models...'); console.log(${JSON.stringify(MODELS)}); process.exit(0)
}
fs.writeFileSync(process.env.AGY_RECORD, JSON.stringify({ args, cwd: process.cwd() }));
const id = '3f1c2d4e-0000-4000-8000-000000000001';
const scenario = process.env.AGY_SCENARIO || 'ok';
if (scenario === 'exit') { console.error('agy: something broke'); process.exit(3) }
console.log(JSON.stringify({ event: 'init', conversation_id: id, init: { model: process.env.AGY_RAN || args[args.indexOf('--model') + 1], cwd: process.cwd(), permission_mode: 'request-review' } }));
if (scenario === 'hang') { setInterval(() => {}, 1000) }
else if (scenario === 'error') { console.log(JSON.stringify({ event: 'result', result: { conversation_id: id, status: 'ERROR', error: 'quota exhausted' } })) }
else {
  console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'done: ' } }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'done: hello', num_turns: 1, usage: { input_tokens: 10, output_tokens: 3, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 13 } } }));
}
`

let dir: string
let bin: string
let work: string
let home: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'flora agy ')))
  bin = join(dir, 'bin')
  work = join(dir, 'project')
  home = join(dir, 'home')
  for (const d of [bin, work, home]) mkdirSync(d)
  writeFileSync(join(dir, 'fixture.mjs'), FIXTURE)
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

// On Windows an npm-style shim next to its script, like the Codex test's: runCommand unwraps it and runs
// the script with our own node, so neither `node` on PATH nor cmd.exe quoting is involved.
function installAgy(where: string): void {
  if (process.platform === 'win32') {
    writeFileSync(join(where, 'fixture.mjs'), FIXTURE)
    writeFileSync(join(where, 'agy.cmd'), '@echo off\r\nnode "%~dp0\\fixture.mjs" %*\r\n')
  } else {
    writeFileSync(join(where, 'agy'), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fixture.mjs')}" "$@"\n`)
    chmodSync(join(where, 'agy'), 0o755)
  }
}

async function run(spec: Partial<ExecutorSpec>, scenario = 'ok', extra: { path?: string; prompt?: string; ran?: string } = {}): Promise<{ evidence: Evidence; record?: { args: string[]; cwd: string } }> {
  const record = join(dir, 'record.json')
  const evidence = await antigravityAdapter.execute({
    spec: { harness: 'antigravity', ...spec },
    prompt: extra.prompt ?? 'Read hello.txt',
    cwd: work,
    env: { PATH: extra.path ?? bin, HOME: home, AGY_RECORD: record, AGY_SCENARIO: scenario, ...(extra.ran ? { AGY_RAN: extra.ran } : {}) }
  })
  let recorded: { args: string[]; cwd: string } | undefined
  try { recorded = JSON.parse(readFileSync(record, 'utf8')) } catch { recorded = undefined }
  return { evidence, record: recorded }
}

const settingsOf = (args: string[]): unknown => JSON.parse(args[args.indexOf('--settings') + 1])

describe('antigravity adapter with a stand-in agy', () => {
  it('is the adapter registered for harness "antigravity"', () => {
    expect(adapterFor('antigravity')).toBe(antigravityAdapter)
  })

  it('a read-only step: sandbox, no --mode, every write/command/network/MCP tool denied, in the run directory', async () => {
    installAgy(bin)
    const { evidence, record } = await run({ access: 'read' })
    expect(evidence.exitCode).toBe(0)
    expect(evidence.output).toBe('done: hello')
    expect(realpathSync.native(record!.cwd)).toBe(realpathSync.native(work))
    const args = record!.args
    expect(args).toContain('--sandbox')
    expect(args).not.toContain('--mode')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(settingsOf(args)).toEqual(ANTIGRAVITY_SETTINGS.read)
    expect(settingsOf(args)).toMatchObject({ agentMode: '', permissions: { deny: expect.arrayContaining(['write_file(*)', 'command(*)', 'mcp(*)']) } })
    expect(args.slice(0, 2)).toEqual(['--output-format', 'stream-json'])
    expect(args.slice(-2)).toEqual(['--print', 'Read hello.txt'])
  })

  it('a multi-line prompt with quotes and the JSON settings reach agy intact', async () => {
    installAgy(bin)
    const prompt = 'Line one says "hi" & 50% <done>\nline two: {"a": [1, 2]} ^ | !'
    const { record } = await run({ access: 'write' }, 'ok', { prompt })
    expect(record!.args.slice(-2)).toEqual(['--print', prompt])
    expect(settingsOf(record!.args)).toEqual(ANTIGRAVITY_SETTINGS.write)
  })

  it('read is the default when a step names no access', async () => {
    installAgy(bin)
    const { record } = await run({})
    expect(record!.args).not.toContain('--mode')
    expect(settingsOf(record!.args)).toEqual(ANTIGRAVITY_SETTINGS.read)
  })

  it('a writing step: sandbox + --mode auto, terminal sandbox on, only MCP denied, in the run directory', async () => {
    installAgy(bin)
    const { evidence, record } = await run({ access: 'write' })
    expect(evidence.exitCode).toBe(0)
    expect(realpathSync.native(record!.cwd)).toBe(realpathSync.native(work))
    const args = record!.args
    expect(args).toContain('--sandbox')
    expect(args[args.indexOf('--mode') + 1]).toBe('auto')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(settingsOf(args)).toEqual({
      agentMode: 'auto', toolPermission: 'request-review', enableTerminalSandbox: true, allowNonWorkspaceAccess: false, permissions: { deny: ['mcp(*)'] }
    })
  })

  it('maps reasoning into the model id, and defaults to Gemini 4 Carbon medium', async () => {
    installAgy(bin)
    const modelOf = (args: string[]): string => args[args.indexOf('--model') + 1]
    expect(modelOf((await run({ model: 'gemini-4-carbon', reasoning: 'high' })).record!.args)).toBe('gemini-4-carbon-high')
    expect(modelOf((await run({ reasoning: 'low' })).record!.args)).toBe('gemini-4-carbon-low')
    expect(modelOf((await run({})).record!.args)).toBe('gemini-4-carbon-medium')
    expect(modelOf((await run({ model: 'gemini-4-carbon-low' })).record!.args)).toBe('gemini-4-carbon-low')
  })

  it('refuses a model agy models does not list, before any work', async () => {
    installAgy(bin)
    const { evidence, record } = await run({ model: 'gemini-9-ultra', reasoning: 'high' })
    expect(evidence.exitCode).toBe(1)
    expect(evidence.output).toMatch(/model "gemini-9-ultra-high" is not offered by `agy models`/)
    expect(record).toBeUndefined()
    expect(explainFailure('antigravity', evidence)).toMatch(/not offered/)
  })

  it('says so when agy models itself fails', async () => {
    installAgy(bin)
    const { evidence, record } = await run({}, 'models-fail')
    expect(evidence.exitCode).toBe(2)
    expect(evidence.output).toMatch(/`agy models` failed.*not signed in/s)
    expect(record).toBeUndefined()
  })

  it('a missing binary is a clear error, not a spawn trace', async () => {
    const { evidence } = await run({})
    expect(evidence.exitCode).toBeNull()
    expect(evidence.output).toMatch(/agy is not installed: not on PATH and not in ~\/\.local\/bin/)
    expect(explainFailure('antigravity', evidence)).toMatch(/agy is not installed/)
  })

  it('finds agy in ~/.local/bin when PATH does not have it', async () => {
    const local = join(home, '.local', 'bin')
    mkdirSync(local, { recursive: true })
    installAgy(local)
    expect(findAgy({ PATH: bin, HOME: home })).toBe(join(local, process.platform === 'win32' ? 'agy.cmd' : 'agy'))
    expect((await run({})).evidence.output).toBe('done: hello')
  })

  it('captures the conversation id as the step session', async () => {
    installAgy(bin)
    const { evidence } = await run({})
    expect(evidence.sessionId).toBe('3f1c2d4e-0000-4000-8000-000000000001')
    expect(evidence.usage).toEqual({ inputTokens: 10, outputTokens: 3, cachedTokens: 5, contextTokens: 15, totalTokens: 13 })
  })

  it('reports a non-zero exit with what agy printed, like codex', async () => {
    installAgy(bin)
    const { evidence } = await run({}, 'exit')
    expect(evidence.exitCode).toBe(3)
    expect(evidence.output).toContain('agy: something broke')
  })

  it('an error result fails the step even when agy exits 0, and keeps the conversation id', async () => {
    installAgy(bin)
    const { evidence } = await run({}, 'error')
    expect(evidence.exitCode).toBe(1)
    expect(evidence.output).toBe('quota exhausted')
    expect(evidence.sessionId).toBe('3f1c2d4e-0000-4000-8000-000000000001')
  })

  it('fails a step whose conversation started on a different model than the one pinned', async () => {
    installAgy(bin)
    const { evidence } = await run({ reasoning: 'high' }, 'ok', { ran: 'gemini-3.8-flash-low' })
    expect(evidence.exitCode).toBe(1)
    expect(evidence.output).toBe('antigravity: agy ran gemini-3.8-flash-low instead of gemini-4-carbon-high')
  })

  it('kills a step at its wall-clock limit and says so, like codex', async () => {
    installAgy(bin)
    const { evidence } = await run({ timeout_min: 0.03, stall_min: 0 }, 'hang')
    expect(evidence.timedOut).toBe(true)
    // POSIX reports the SIGKILL as 137, Windows' taskkill as 1 — what matters is that the step was killed.
    expect(evidence.exitCode).not.toBe(0)
    expect(evidence.output).toMatch(/killed at the .* min wall-clock limit/)
    expect(evidence.sessionId).toBe('3f1c2d4e-0000-4000-8000-000000000001')
  }, 15_000)

  it('refuses flags that would loosen permissions or change how the answer is read', async () => {
    installAgy(bin)
    for (const flag of ['--dangerously-skip-permissions', '--mode=plan', '-settings', '--model']) {
      const { evidence, record } = await run({ args: [flag] })
      expect(evidence.exitCode).toBe(1)
      expect(evidence.output).toMatch(/flora owns that flag/)
      expect(record).toBeUndefined()
    }
  })
})

describe('antigravity pure parts', () => {
  it('reads agy models output, banner and blank lines skipped', () => {
    expect(parseAntigravityModels(`Fetching available models...\n\n${MODELS}\n`)).toEqual([
      'gemini-4-carbon-medium', 'gemini-4-carbon-high', 'gemini-4-carbon-low', 'gemini-pro-orchestrator'
    ])
  })

  it('takes a listed id without a level as is, and refuses a level named twice', () => {
    const listed = parseAntigravityModels(MODELS)
    expect(antigravityModel({ model: 'gemini-pro-orchestrator' }, listed)).toEqual({ ok: true, model: 'gemini-pro-orchestrator' })
    expect(antigravityModel({ model: 'gemini-4-carbon-high', reasoning: 'low' }, listed)).toMatchObject({ ok: false, error: expect.stringContaining('already names a reasoning level') })
    expect(antigravityModel({ reasoning: 'xhigh' }, listed)).toMatchObject({ ok: false, error: expect.stringContaining('gemini-4-carbon: gemini-4-carbon-medium, gemini-4-carbon-high, gemini-4-carbon-low') })
  })

  it('a stream without a result frame is a failure; no frames at all is not a stream', () => {
    expect(parseAntigravityStream('{"event":"init","conversation_id":"c1","init":{"model":"m"}}')).toMatchObject({ isError: true, conversationId: 'c1', model: 'm' })
    expect(parseAntigravityStream('plain text')).toBeNull()
  })

  // Trimmed from a real agy 1.5.9 read-only run (tool list and text deltas shortened).
  it('reads a real agy stream: answer, conversation id, model, usage', () => {
    const real = [
      '{"event":"init","conversation_id":"e01e2897-72a2-4124-b5b4-98e38f95ba8a","init":{"model":"gemini-4-carbon-low","cwd":"/private/tmp/flora-agy-live.4z3M","tools":["read_file","write_to_file"],"permission_mode":"request-review"}}',
      '{"event":"step_update","step_update":{"conversation_id":"e01e2897-72a2-4124-b5b4-98e38f95ba8a","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","duration_seconds":0.059151,"tool_info":{"name":"read_file","parameters":{"Path":"/private/tmp/flora-agy-live.4z3M/hello.txt"},"output":"2 lines, 26 bytes"}}}',
      '{"event":"step_update","step_update":{"conversation_id":"e01e2897-72a2-4124-b5b4-98e38f95ba8a","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"The exact contents of"}}',
      '{"event":"result","result":{"conversation_id":"e01e2897-72a2-4124-b5b4-98e38f95ba8a","status":"SUCCESS","response":"The exact contents of hello.txt are:\\n\\n```text\\nflora live check\\nline two\\n```\\n","duration_seconds":11.476025,"num_turns":1,"usage":{"input_tokens":12804,"output_tokens":88,"thinking_tokens":0,"cache_read_tokens":8559,"total_tokens":12892}}}'
    ].join('\n')
    expect(parseAntigravityStream(real)).toEqual({
      result: 'The exact contents of hello.txt are:\n\n```text\nflora live check\nline two\n```\n',
      isError: false,
      error: undefined,
      conversationId: 'e01e2897-72a2-4124-b5b4-98e38f95ba8a',
      model: 'gemini-4-carbon-low',
      usage: { inputTokens: 12804, outputTokens: 88, cachedTokens: 8559, contextTokens: 21363, totalTokens: 12892 }
    })
  })
})

describe('doctor: antigravity', () => {
  const ev = (output: string, exitCode: number | null = 0): Evidence => ({ output, exitCode, durationMs: 1 })
  it('optional when absent; ready only when agy models lists models', () => {
    expect(interpretAntigravity(null, ev('', null), ev('', null))).toMatchObject({ ok: null, detail: 'not installed (optional)' })
    expect(interpretAntigravity('/u/.local/bin/agy', ev('1.5.9'), ev(`Fetching available models...\n${MODELS}`))).toMatchObject({
      ok: true, detail: '1.5.9 · 4 models (3 Gemini 4 Carbon) · /u/.local/bin/agy'
    })
    expect(interpretAntigravity('/u/agy', ev('1.5.9'), ev('Fetching available models...\nnot signed in', 1))).toMatchObject({
      ok: false, detail: '1.5.9 · `agy models` failed: not signed in'
    })
    expect(interpretAntigravity('/u/agy', ev('boom', 1), ev('', 1))).toMatchObject({ ok: false, detail: 'cannot start: boom' })
  })
})

describe('contract: antigravity', () => {
  const load = (yaml: string): WorkflowSpec => parse(yaml) as WorkflowSpec
  const both = (yaml: string): { code: boolean; schema: number } => {
    const spec = load(yaml)
    let code = true
    try { validateWorkflow(spec) } catch (err) { if (!(err instanceof WorkflowError)) throw err; code = false }
    return { code, schema: schemaErrors(spec).length }
  }

  it('accepts antigravity with model, reasoning and access', () => {
    expect(both('name: x\nsteps:\n  - { id: a, executor: { harness: antigravity, model: gemini-4-carbon, reasoning: high, access: write }, prompt: x }\n')).toEqual({ code: true, schema: 0 })
    expect(both('name: x\nsteps:\n  - { id: a, executor: { harness: antigravity }, prompt: x }\n')).toEqual({ code: true, schema: 0 })
  })

  it('still rejects an unknown harness', () => {
    const result = both('name: x\nsteps:\n  - { id: a, executor: { harness: gemini }, prompt: x }\n')
    expect(result.code).toBe(false)
    expect(result.schema).toBeGreaterThan(0)
  })

  it('rejects reasoning/access on other harnesses, bad values, owned flags and tools', () => {
    for (const yaml of [
      'name: x\nsteps:\n  - { id: a, executor: { harness: codex, access: write }, prompt: x }\n',
      'name: x\nsteps:\n  - { id: a, executor: { harness: antigravity, reasoning: extreme }, prompt: x }\n',
      'name: x\nsteps:\n  - { id: a, executor: { harness: antigravity, access: admin }, prompt: x }\n',
      'name: x\nsteps:\n  - { id: a, executor: { harness: antigravity }, prompt: x, tools: [{ flora: read_context }] }\n'
    ]) {
      const result = both(yaml)
      expect(result.code, yaml).toBe(false)
      expect(result.schema, yaml).toBeGreaterThan(0)
    }
    expect(both('name: x\nsteps:\n  - { id: a, executor: { harness: antigravity, args: [--dangerously-skip-permissions] }, prompt: x }\n').code).toBe(false)
    expect(schemaErrors(load('name: x\nsteps:\n  - { id: a, executor: { harness: codex, reasoning: high }, prompt: x }\n'))).toContainEqual({
      path: 'steps[0].executor', message: 'reasoning and access only apply to the antigravity harness'
    })
  })
})
