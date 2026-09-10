import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { parseClaudeStream } from '../adapters/claude-code'
import { parseCodexStream } from '../adapters/codex'
import { apiAdapter } from '../adapters/api'

vi.mock('../providers', () => ({ resolveProvider: () => ({ base_url: 'http://unused.invalid', default_model: 'fixture' }) }))
afterEach(() => vi.unstubAllGlobals())

it.each([{ subtype: 3 }, { errors: 'bad' }, { result: {} }, { total_cost_usd: 'free' }])('rejects malformed Claude frame fields: %j', (fields) => {
  const summary = parseClaudeStream(JSON.stringify({ type: 'result', ...fields }))
  expect(summary?.isError).toBe(true)
  expect(typeof summary?.result).toBe('string')
  expect(summary?.costUsd).toBeUndefined()
})

it('keeps malformed Codex error payloads out of text evidence', () => {
  const summary = parseCodexStream('{"type":"turn.failed","error":{"message":{"nested":"bad"}}}')
  expect(summary?.isError).toBe(true)
  expect(summary?.error).toBe('turn failed')
})

it('turns a JSON null provider response into ordinary failed evidence', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })))
  const result = await apiAdapter.execute({ cwd: '.', spec: { harness: 'api', provider: 'fixture' }, prompt: 'fixture' })
  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('text completion')
})

it('rejects output observer errors through the command promise instead of crashing its host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flora-observer-'))
  try {
    const file = join(dir, 'observer.mts')
    writeFileSync(file, `
      import { runCommand } from ${JSON.stringify(pathToFileURL(resolve('src/adapters/command.ts')).href)};
      try {
        await runCommand(process.execPath, ['-e', 'console.log("ready")'], {
          cwd: ${JSON.stringify(dir)}, onOutput() { throw new Error('observer failed'); }
        });
        process.exitCode = 2;
      } catch (error) { console.log('caught: ' + error.message); }
    `)
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', file], { cwd: process.cwd(), timeout: 10_000, windowsHide: true })
    expect(result.stdout).toContain('caught: observer failed')
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5 }) }
})
