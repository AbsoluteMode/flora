import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runCommand } from '../adapters/command'
import { codexArgs, parseCodexStream } from '../adapters/codex'
import { claudeArgs, parseClaudeStream } from '../adapters/claude-code'
import { interpretClaude, interpretCodex, interpretHarmonia } from '../doctor'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flora harness ')) })
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
it('does not try to spawn work after cancellation', async () => {
  const signal = AbortSignal.abort()
  const result = await runCommand('definitely-missing-flora-command', [], { cwd: dir, signal })
  expect(result.exitCode).toBe(137)
  expect(result.output).toMatch(/aborted/)
})
it.runIf(process.platform === 'win32')('resolves explicit batch paths and the child PATH', async () => {
  const file = join(dir, 'probe.cmd')
  writeFileSync(file, '@echo off\r\necho found\r\n')
  expect((await runCommand(file, [], { cwd: dir })).output).toBe('found')
  expect((await runCommand('probe', [], { cwd: dir, env: { PATH: dir } })).output).toBe('found')
})
it('marks interrupted JSON streams and Claude error subtypes as failures', () => {
  expect(parseCodexStream('{"type":"turn.started"}')?.isError).toBe(true)
  expect(parseClaudeStream('{"type":"result","subtype":"error_max_turns","errors":["limit"]}')?.isError).toBe(true)
})
it('separates a Codex prompt beginning with a flag from options', () => {
  const args = codexArgs({ spec: { harness: 'codex' }, prompt: '--help', cwd: dir })
  expect(args.slice(-2)).toEqual(['--', '--help'])
})
it('keeps personal Claude MCP servers out of steps with no declared servers', () => {
  expect(claudeArgs({ spec: { harness: 'claude-code' }, prompt: 'hello', cwd: dir })).toContain('--strict-mcp-config')
})
it('never calls failed version/status probes ready', () => {
  const bad = { exitCode: 1, output: 'failed', durationMs: 1 }
  const good = { ...bad, exitCode: 0, output: '1.0' }
  expect(interpretHarmonia(bad).ok).not.toBe(true)
  expect(interpretClaude(bad, { ...good, output: '{"loggedIn":true}' }, {}).ok).not.toBe(true)
  expect(interpretCodex(good, { ...bad, output: 'Logged in using ChatGPT' }, {}).ok).not.toBe(true)
})
