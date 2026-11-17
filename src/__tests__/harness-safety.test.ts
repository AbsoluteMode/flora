import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runCommand } from '../adapters/command'
import { codexArgs, disableServersArg, parseCodexStream } from '../adapters/codex'
import { claudeArgs, parseClaudeStream } from '../adapters/claude-code'
import { interpretClaude, interpretCodex } from '../doctor'

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
  expect(interpretClaude(bad, { ...good, output: '{"loggedIn":true}' }, {}).ok).not.toBe(true)
  expect(interpretCodex(good, { ...bad, output: 'Logged in using ChatGPT' }, {}).ok).not.toBe(true)
})

// A personal server that comes from a Codex plugin has no top-level mcp_servers entry: switching it
// off with `{enabled=false}` alone made Codex refuse to start ("invalid transport in mcp_servers.x").
it('switches personal Codex servers off with their own transport, plugin servers included', () => {
  const arg = disableServersArg([
    { name: 'claude-ask', transport: { type: 'stdio', command: 'node' } },
    { name: 'docs', transport: { type: 'streamable_http', url: 'https://docs.test/mcp' } },
    { name: 'odd "name".x', transport: {} }
  ])
  expect(arg).toEqual([
    '-c',
    'mcp_servers={"claude-ask"={command="node",enabled=false},"docs"={url="https://docs.test/mcp",enabled=false},"odd \\"name\\".x"={command="true",enabled=false}}'
  ])
  expect(disableServersArg([])).toEqual([])
  expect(codexArgs({ spec: { harness: 'codex' }, prompt: 'p', cwd: dir }, [{ name: 'a', transport: { command: 'x' } }]))
    .toContain('mcp_servers={"a"={command="x",enabled=false}}')
})

const hasCodex = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0
it.runIf(hasCodex)('real codex accepts the override for a server it has no top-level entry for', () => {
  const home = mkdtempSync(join(tmpdir(), 'flora codex home '))
  try {
    const list = (override: string[]) =>
      spawnSync('codex', [...override, 'mcp', 'list', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } })
    const old = list(['-c', 'mcp_servers={"plug"={enabled=false}}'])
    expect(old.status, 'the shape flora used to send').not.toBe(0)
    expect(old.stderr + old.stdout).toMatch(/invalid transport/)

    const fixed = list(disableServersArg([{ name: 'plug', transport: { type: 'stdio', command: 'node' } }]))
    expect(fixed.status, fixed.stderr).toBe(0)
    const servers = JSON.parse(fixed.stdout) as { name: string; enabled: boolean }[]
    expect(servers.find((s) => s.name === 'plug')?.enabled).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
})
