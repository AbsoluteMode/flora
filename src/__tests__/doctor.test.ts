import { describe, expect, it } from 'vitest'
import { explainFailure, formatProbes, interpretClaude, interpretCodex, interpretGit, interpretHarmonia, interpretInstall, interpretNode } from '../doctor'
import type { Evidence } from '../types'

const ev = (output: string, exitCode: number | null = 0): Evidence => ({ output, exitCode, durationMs: 1 })
const missing = ev('[spawn error: spawn codex ENOENT]', null)

describe('doctor interpreters', () => {
  it('flora: the version with the directory it runs from, and a checkout said out loud', () => {
    expect(interpretInstall('0.1.0', '/usr/lib/node_modules/@absolutemode/flora', false)).toMatchObject({
      ok: true,
      detail: '0.1.0 · /usr/lib/node_modules/@absolutemode/flora',
      hint: undefined
    })
    expect(interpretInstall('0.1.0', '/home/me/flora', true).hint).toContain('working tree')
  })

  it('node: 22.5+ for node:sqlite', () => {
    expect(interpretNode('22.19.0').ok).toBe(true)
    expect(interpretNode('20.11.0')).toMatchObject({ ok: false, hint: expect.stringContaining('22.5') })
  })

  it('git: optional, named as such', () => {
    expect(interpretGit(ev('git version 2.43.0'))).toMatchObject({ ok: true, detail: '2.43.0' })
    expect(interpretGit(missing)).toMatchObject({ ok: null, hint: expect.stringContaining('parallel') })
  })

  it('claude-code: logged in, token from the environment, or not logged in with the fix', () => {
    const version = ev('2.1.138 (Claude Code)')
    expect(interpretClaude(version, ev('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'), {})).toMatchObject({
      ok: true,
      detail: '2.1.138 (Claude Code) · logged in (claude.ai)'
    })
    expect(interpretClaude(version, ev('{"loggedIn":false,"authMethod":"none"}'), { ANTHROPIC_AUTH_TOKEN: 'x', ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' })).toMatchObject({
      ok: true,
      detail: expect.stringContaining('via https://openrouter.ai/api')
    })
    expect(interpretClaude(version, ev('{"loggedIn":false,"authMethod":"none"}', 1), {})).toMatchObject({
      ok: false,
      hint: expect.stringContaining('/login')
    })
    expect(interpretClaude(ev('[spawn error: spawn claude ENOENT]', null), missing, {})).toMatchObject({ ok: false, detail: 'not installed' })
  })

  it('codex: a broken config is the first thing it reports, with the file to fix', () => {
    const version = ev('codex-cli 0.121.0')
    const broken = ev('Error loading configuration: C:\\Users\\me\\.codex\\config.toml:7:16: unknown variant `default`, expected `fast` or `flex`', 1)
    expect(interpretCodex(version, broken, {})).toMatchObject({
      ok: false,
      detail: expect.stringContaining('unknown variant `default`'),
      hint: expect.stringContaining('~/.codex/config.toml')
    })
    expect(interpretCodex(version, broken, { CODEX_HOME: '/x' }).hint).toContain('$CODEX_HOME (/x)')
    expect(interpretCodex(version, ev('Not logged in', 1), {})).toMatchObject({ ok: false, hint: expect.stringContaining('codex login') })
    expect(interpretCodex(version, ev('Not logged in', 1), { OPENAI_API_KEY: 'k' }).ok).toBe(true)
    expect(interpretCodex(version, ev('Logged in using ChatGPT'), {})).toMatchObject({ ok: true, detail: '0.121.0 · logged in using chatgpt' })
    expect(interpretCodex(missing, missing, {})).toMatchObject({ ok: false, detail: 'not installed' })
  })

  it('harmonia: optional, so never a problem — absent, unversioned, or versioned', () => {
    expect(interpretHarmonia(ev('[spawn error: spawn harmonia ENOENT]', null))).toMatchObject({ ok: null, detail: 'not installed (optional)' })
    // An older harmonia starts its session on --version and the probe stalls it: present, no version, no ✗.
    const stalled: Evidence = { output: 'harmonia · project "flora" (registered)\norchestrator google/gemini-3.7-flash', exitCode: null, durationMs: 6000, stalled: true }
    expect(interpretHarmonia(stalled)).toMatchObject({ ok: null, detail: expect.stringContaining('no answer to --version') })
    expect(interpretHarmonia(ev('harmonia 1.0.0'))).toMatchObject({ ok: true, detail: 'harmonia 1.0.0' })
  })

  it('formats one line per probe with the hint underneath', () => {
    const text = formatProbes([
      { name: 'node', ok: true, detail: 'v22' },
      { name: 'codex', ok: false, detail: 'cannot load its config', hint: 'fix it' },
      { name: 'harmonia', ok: null, detail: 'not installed (optional)' }
    ])
    expect(text).toContain('✓ node')
    expect(text).toContain('✗ codex')
    expect(text).toContain('→ fix it')
    expect(text).toContain('· harmonia')
  })
})

describe('failed-step explanations', () => {
  it('names the missing binary', () => {
    expect(explainFailure('codex', missing)).toMatch(/codex is not installed.*flora doctor/)
  })

  it('translates the two most common start-up failures', () => {
    expect(explainFailure('codex', ev('Error loading config.toml: unknown variant `default`, expected `fast` or `flex`\nin `service_tier`', 1))).toMatch(
      /codex cannot load its config \(unknown variant `default`.*CODEX_HOME/
    )
    expect(explainFailure('claude-code', ev('Not logged in · Please run /login', 1))).toMatch(/not logged in.*\/login/)
    expect(explainFailure('claude-code', ev('{"error":"authentication_failed"}', 1))).toMatch(/not logged in/)
  })

  it('stays quiet about failures it does not recognise', () => {
    expect(explainFailure('command', ev('boom', 1))).toBeUndefined()
    expect(explainFailure('claude-code', ev('some ordinary transcript', 1))).toBeUndefined()
  })
})
