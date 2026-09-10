import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCommand } from '../adapters/command'
import { parseClaudeStream } from '../adapters/claude-code'
import { parseUsage } from '../adapters/usage'
import { parseCodexStream } from '../adapters/codex'
import { harmoniaUsage } from '../adapters/harmonia'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-runner-'))
})
// Node 22's rmSync can skip retries when the initial rmdir returns EBUSY.
// The async path retries that error too, while Windows releases cwd handles.
const removeScratch = () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
afterEach(removeScratch)

const node = (script: string) => [process.execPath, ['-e', script]] as const

/** Minutes, because that is the contract's unit — but tests cannot wait minutes. */
const SECONDS = 1 / 60

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

it.runIf(process.platform === 'win32')('retries cleanup while Windows is releasing a process working directory', async () => {
  // A live process holds its cwd on Windows. Release it shortly after the first
  // removal attempt to reproduce EBUSY without relying on a taskkill race.
  const child = spawn(process.execPath, ['-e', `
    process.on('message', () => setTimeout(() => process.exit(0), 200));
    process.send('ready');
    setTimeout(() => process.exit(1), 5000).unref();
  `], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  const closed = once(child, 'close')
  try {
    await once(child, 'message')
    expect(existsSync(dir)).toBe(true)
    child.send('release')
    await removeScratch()
    expect(existsSync(dir)).toBe(false)
    expect(await closed).toEqual([0, null])
  } finally {
    if (child.exitCode === null) child.kill()
    await closed
  }
})

describe('stall detection', () => {
  it('kills a silent process after stall_min and marks the evidence', async () => {
    const [cmd, args] = node('setTimeout(() => {}, 60000)')
    const started = Date.now()
    const evidence = await runCommand(cmd, [...args], { cwd: dir, stallMin: 0.6 * SECONDS })
    const took = Date.now() - started

    expect(evidence.stalled).toBe(true)
    expect(evidence.timedOut).toBeUndefined()
    expect(evidence.exitCode).not.toBe(0)
    expect(evidence.exitCode).not.toBeNull()
    expect(evidence.output).toContain('killed after')
    expect(took).toBeGreaterThanOrEqual(500)
    expect(took).toBeLessThan(5000)
  })

  it('takes the whole process tree with it — no orphans', async () => {
    // A harness that spawns a silent worker and then goes silent itself.
    const pidFile = join(dir, 'grandchild.pid')
    const harness = join(dir, 'harness.cjs')
    writeFileSync(
      harness,
      `const { spawn } = require('node:child_process');
       const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
       require('node:fs').writeFileSync(process.argv[2], String(child.pid));
       setTimeout(() => {}, 60000);`
    )
    const evidence = await runCommand(process.execPath, [harness, pidFile], { cwd: dir, stallMin: 0.6 * SECONDS })
    expect(evidence.stalled).toBe(true)

    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    expect(grandchild).toBeGreaterThan(0)
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true)
  })

  it('stall_min: 0 disables the silence timer', async () => {
    const [cmd, args] = node('setTimeout(() => console.log("late"), 900)')
    const evidence = await runCommand(cmd, [...args], { cwd: dir, stallMin: 0, timeoutMin: 0.3 * SECONDS * 10 })
    expect(evidence.stalled).toBeUndefined()
    expect(evidence.output).toBe('late')
  })
})

describe('wall-clock timeout', () => {
  it('kills work that never finishes even though it keeps printing', async () => {
    const [cmd, args] = node('setInterval(() => console.log("still going"), 100)')
    const evidence = await runCommand(cmd, [...args], { cwd: dir, stallMin: 0, timeoutMin: 0.7 * SECONDS })
    expect(evidence.timedOut).toBe(true)
    expect(evidence.stalled).toBeUndefined()
    expect(evidence.exitCode).not.toBe(0)
    expect(evidence.output).toContain('wall-clock')
  })
})

describe('closed stdin', () => {
  it('a harness that waits for an answer gets EOF instead of hanging', async () => {
    const [cmd, args] = node(
      'process.stdin.on("data", () => {}); process.stdin.on("end", () => { console.log("eof"); process.exit(0) })'
    )
    const evidence = await runCommand(cmd, [...args], { cwd: dir, stallMin: 2 * SECONDS })
    expect(evidence.output).toBe('eof')
    expect(evidence.exitCode).toBe(0)
    expect(evidence.stalled).toBeUndefined()
  })
})

describe('abort', () => {
  it('kills the tree and fails the step', async () => {
    const abort = new AbortController()
    const [cmd, args] = node('setInterval(() => console.log("busy"), 100)')
    setTimeout(() => abort.abort(), 300)
    const evidence = await runCommand(cmd, [...args], { cwd: dir, signal: abort.signal, stallMin: 0 })
    // POSIX reports the SIGKILL as 137, Windows' taskkill as 1 — what matters
    // is that a killed process can never read as a success.
    expect(evidence.exitCode).not.toBe(0)
    expect(evidence.exitCode).not.toBeNull()
    expect(evidence.output).toContain('aborted')
  })
})

describe('usage parsing', () => {
  it('claude-code: takes the result frame out of a stream-json transcript', () => {
    const transcript = [
      '{"type":"system","subtype":"init","session_id":"s1","tools":["Bash"]}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking…"}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}',
      'not json at all',
      '{"type":"result","subtype":"success","is_error":false,"result":"REVIEW_CLEAN","total_cost_usd":0.0412,"duration_ms":5000,"num_turns":3,"session_id":"s1","usage":{"input_tokens":1200,"output_tokens":340,"cache_creation_input_tokens":500,"cache_read_input_tokens":8000}}'
    ].join('\n')

    const summary = parseClaudeStream(transcript)
    expect(summary).toEqual({
      result: 'REVIEW_CLEAN',
      isError: false,
      costUsd: 0.0412,
      // Anthropic counts cache reads outside input_tokens: context = 1200 + 8000 + 500.
      usage: { inputTokens: 1200, outputTokens: 340, cachedTokens: 8000, contextTokens: 9700, totalTokens: 10040 }
    })
  })

  it('claude-code: an error subtype surfaces its errors and is marked as one', () => {
    const summary = parseClaudeStream(
      '{"type":"result","subtype":"error_max_turns","is_error":true,"errors":["max turns reached"],"total_cost_usd":0.1,"num_turns":10,"usage":{"input_tokens":10,"output_tokens":5}}'
    )
    expect(summary?.isError).toBe(true)
    expect(summary?.result).toBe('max turns reached')
    expect(summary?.usage?.inputTokens).toBe(10)
  })

  it('claude-code: a real 2.1.138 frame - is_error under a success subtype, nested usage objects', () => {
    // Captured from `claude -p --output-format stream-json --verbose` on this machine (logged out).
    const line =
      '{"type":"result","subtype":"success","is_error":true,"api_error_status":null,"duration_ms":54,"duration_api_ms":0,"num_turns":1,"result":"Not logged in \u00b7 Please run /login","stop_reason":"stop_sequence","session_id":"d30062b2","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"759fb34b"}'
    const summary = parseClaudeStream(line)
    expect(summary?.isError).toBe(true)
    expect(summary?.result).toBe('Not logged in · Please run /login')
    expect(summary?.costUsd).toBe(0)
    expect(summary?.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextTokens: 0, totalTokens: 0 })
  })

  it('claude-code: no result frame means no summary, not a crash', () => {
    expect(parseClaudeStream('claude: command not found')).toBeNull()
  })

  it('codex: takes the last agent message and the turn usage out of --json', () => {
    const transcript = [
      '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls","exit_code":0}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Looking at the tree first."}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done. I updated the docs and added examples."}}',
      '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}'
    ].join('\n')

    const summary = parseCodexStream(transcript)
    expect(summary?.result).toBe('Done. I updated the docs and added examples.')
    expect(summary?.isError).toBe(false)
    // OpenAI counts cache reads inside input_tokens: context stays 24763.
    expect(summary?.usage).toEqual({
      inputTokens: 24763,
      outputTokens: 122,
      cachedTokens: 24448,
      contextTokens: 24763,
      totalTokens: 24885
    })
  })

  it('codex: turn.failed and error events mark the turn as failed', () => {
    const failed = parseCodexStream(
      '{"type":"thread.started","thread_id":"t"}\n{"type":"turn.failed","error":{"message":"model response stream ended unexpectedly"}}'
    )
    expect(failed?.isError).toBe(true)
    expect(failed?.error).toBe('model response stream ended unexpectedly')

    const errored = parseCodexStream('{"type":"error","message":"stream error: broken pipe"}')
    expect(errored?.isError).toBe(true)
    expect(errored?.error).toBe('stream error: broken pipe')
  })

  it('codex: plain-text output (no --json) is not JSONL, but its footer still counts', () => {
    expect(parseCodexStream('Done. Edited 2 files.\n\ntokens used: 12,345\n')).toBeNull()
    expect(parseUsage('Done. Edited 2 files.\n\ntokens used: 12,345\n')).toEqual({ totalTokens: 12345 })
    expect(parseUsage('Tokens used\n7 890\n')).toBeUndefined() // a space-separated number is not a count we trust
    expect(parseUsage('nothing here')).toBeUndefined()
  })

  it('harmonia: reads a key=value summary line', () => {
    expect(harmoniaUsage('working…\nsummary: input=1200 output=340 cached=8000 limit=42%')).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cachedTokens: 8000,
      contextTokens: 1200,
      totalTokens: 1540,
      limitPct: 42
    })
  })

  it('universal: provider dialects normalise to one shape', () => {
    // OpenAI: cached is a subset of prompt_tokens.
    expect(parseUsage('{"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":40}}}')).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 40,
      contextTokens: 100,
      totalTokens: 120
    })
    // Gemini: camelCase, cached inside the prompt count.
    expect(parseUsage('{"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":10,"totalTokenCount":60,"cachedContentTokenCount":30}}')).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cachedTokens: 30,
      contextTokens: 50,
      totalTokens: 60
    })
    // Anthropic: cache reads and writes sit outside input_tokens.
    expect(parseUsage('{"type":"result","usage":{"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":8000,"cache_creation_input_tokens":500}}')).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cachedTokens: 8000,
      contextTokens: 9700,
      totalTokens: 10040
    })
  })

  it('universal: the last usage object wins, and text fills what JSON left out', () => {
    const transcript = [
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}',
      'some prose about the input file',
      '{"type":"turn.completed","usage":{"input_tokens":300,"output_tokens":40}}',
      'quota: 42% of weekly limit used'
    ].join('\n')
    expect(parseUsage(transcript)).toEqual({
      inputTokens: 300,
      outputTokens: 40,
      contextTokens: 300,
      totalTokens: 340,
      limitPct: 42
    })
  })

  it('universal: text forms — colon, equals, number-first, percent-first', () => {
    expect(parseUsage('input_tokens: 1,000\noutput_tokens: 250')).toEqual({ inputTokens: 1000, outputTokens: 250, contextTokens: 1000, totalTokens: 1250 })
    expect(parseUsage('12,345 tokens used')).toEqual({ totalTokens: 12345 })
    expect(parseUsage('You have used 87% of your weekly limit.')).toEqual({ limitPct: 87 })
    expect(parseUsage('please read the input file and write the output file')).toBeUndefined()
  })
})
