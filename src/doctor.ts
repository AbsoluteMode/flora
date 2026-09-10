import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCommand } from './adapters/command'
import { loadProviders } from './providers'
import { floraVersion, isCheckout, PACKAGE_ROOT } from './version'
import type { Evidence } from './types'

/**
 * `flora doctor`: is this machine ready to run contracts? One line per
 * dependency and harness, with the fix when something is off. Every probe
 * is free — version flags and the harnesses' own auth/status commands, which
 * load their config and report without calling a model.
 */
export interface Probe {
  name: string
  /** true = ready, false = will not work, null = optional / unknown */
  ok: boolean | null
  detail: string
  hint?: string
}

const PROBE_LIMITS = { timeoutMin: 0.5, stallMin: 0.5 }
// A harness that answers a version flag by starting up instead is given a few
// seconds, not the half minute a status command may need.
const SHORT_PROBE = { timeoutMin: 0.1, stallMin: 0.1 }

async function probe(command: string, args: string[], limits = PROBE_LIMITS): Promise<Evidence> {
  return runCommand(command, args, { cwd: process.cwd(), ...limits })
}

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? ''
const notFound = (evidence: Evidence): boolean => evidence.exitCode === null && /ENOENT/.test(evidence.output)

// ── pure interpreters (tested without the binaries) ────────────────────────

/**
 * Which flora is this? A global install and a `npm link` answer `--version`
 * the same way, but a linked checkout runs whatever its working tree holds at
 * this moment — so the path, and that fact, belong next to the number.
 */
export function interpretInstall(version: string, root: string, checkout: boolean): Probe {
  return {
    name: 'flora',
    ok: true,
    detail: `${version} · ${root}`,
    hint: checkout ? 'a checkout, not an installed release — it runs whatever this working tree currently holds' : undefined
  }
}

export function interpretNode(version: string): Probe {
  const [major, minor] = version.split('.').map(Number)
  const ok = major > 22 || (major === 22 && minor >= 5)
  return {
    name: 'node',
    ok,
    detail: `v${version}`,
    hint: ok ? undefined : 'flora needs Node 22.5+ (node:sqlite for the journal)'
  }
}

export function interpretGit(evidence: Evidence): Probe {
  if (notFound(evidence) || evidence.exitCode !== 0) {
    return { name: 'git', ok: null, detail: 'not found', hint: 'needed only for parallel steps with worktree isolation' }
  }
  return { name: 'git', ok: true, detail: firstLine(evidence.output).replace(/^git version /, '') }
}

export function interpretClaude(version: Evidence, status: Evidence, env: NodeJS.ProcessEnv): Probe {
  if (notFound(version)) {
    return { name: 'claude-code', ok: false, detail: 'not installed', hint: 'npm install -g @anthropic-ai/claude-code' }
  }
  if (version.exitCode !== 0) return { name: 'claude-code', ok: false, detail: `cannot start: ${firstLine(version.output)}` }
  const v = firstLine(version.output)
  let auth: { loggedIn?: boolean; authMethod?: string } = {}
  try {
    auth = JSON.parse(status.output.trim().slice(status.output.indexOf('{'))) as typeof auth
  } catch {
    // an older claude without `auth status` — fall through to the env check
  }
  if (status.exitCode === 0 && auth.loggedIn) return { name: 'claude-code', ok: true, detail: `${v} · logged in (${auth.authMethod ?? 'session'})` }
  if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) {
    const via = env.ANTHROPIC_BASE_URL ? ` via ${env.ANTHROPIC_BASE_URL}` : ''
    return { name: 'claude-code', ok: true, detail: `${v} · token from the environment${via}` }
  }
  return {
    name: 'claude-code',
    ok: false,
    detail: `${v} · not logged in`,
    hint: 'run `claude` once and /login, or set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL for a gateway)'
  }
}

export function interpretCodex(version: Evidence, status: Evidence, env: NodeJS.ProcessEnv): Probe {
  if (notFound(version)) {
    return { name: 'codex', ok: false, detail: 'not installed', hint: 'npm install -g @openai/codex' }
  }
  if (version.exitCode !== 0) return { name: 'codex', ok: false, detail: `cannot start: ${firstLine(version.output)}` }
  const v = firstLine(version.output).replace(/^codex-cli\s+/, '')
  const out = status.output
  const configError = /Error loading config(?:uration|\.toml)?:?\s*(.*)/i.exec(out)
  if (configError) {
    const where = env.CODEX_HOME ? `$CODEX_HOME (${env.CODEX_HOME})` : '~/.codex/config.toml'
    return {
      name: 'codex',
      ok: false,
      detail: `${v} · cannot load its config: ${firstLine(configError[1])}`,
      hint: `codex refuses to start until ${where} parses — fix that line, or point CODEX_HOME at a directory with a config that works (examples/e2e/codex-home is one)`
    }
  }
  if (status.exitCode === 0 && /logged in/i.test(out) && !/not logged in/i.test(out)) {
    return { name: 'codex', ok: true, detail: `${v} · ${firstLine(out).toLowerCase()}` }
  }
  if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return { name: 'codex', ok: true, detail: `${v} · API key from the environment` }
  return { name: 'codex', ok: false, detail: `${v} · not logged in`, hint: 'run `codex login`, or set OPENAI_API_KEY' }
}

/**
 * harmonia is optional, so nothing about it is a problem: absent is a dot, and
 * a harmonia that starts its session instead of answering `--version` (the
 * ones before the flag existed) is present but unversioned — a dot as well,
 * never a ✗. Only an answer with exit 0 earns the check mark and the version.
 */
export function interpretHarmonia(version: Evidence): Probe {
  if (notFound(version)) return { name: 'harmonia', ok: null, detail: 'not installed (optional)' }
  if (version.exitCode !== 0) {
    return { name: 'harmonia', ok: null, detail: 'installed · no answer to --version (optional)', hint: 'an older harmonia starts a session instead; update it for the version here' }
  }
  return { name: 'harmonia', ok: true, detail: firstLine(version.output) }
}

// ── the run ────────────────────────────────────────────────────────────────

export async function doctor(env: NodeJS.ProcessEnv = process.env): Promise<Probe[]> {
  const results: Probe[] = [interpretInstall(floraVersion(), PACKAGE_ROOT, isCheckout()), interpretNode(process.versions.node)]
  results.push(interpretGit(await probe('git', ['--version'])))

  const claudeVersion = await probe('claude', ['--version'])
  const claudeStatus = notFound(claudeVersion) ? claudeVersion : await probe('claude', ['auth', 'status'])
  results.push(interpretClaude(claudeVersion, claudeStatus, env))

  const codexVersion = await probe('codex', ['--version'])
  const codexStatus = notFound(codexVersion) ? codexVersion : await probe('codex', ['login', 'status'])
  results.push(interpretCodex(codexVersion, codexStatus, env))

  results.push(interpretHarmonia(await probe('harmonia', ['--version'], SHORT_PROBE)))

  // Model API providers are opt-in: listed only when providers.yaml exists.
  const home = env.FLORA_HOME ?? (env.FLORA_DB ? dirname(env.FLORA_DB) : join(homedir(), '.flora'))
  const providersFile = join(home, 'providers.yaml')
  try {
    const providers = loadProviders(providersFile)
    for (const p of Object.values(providers)) {
      const keyed = p.api_key_env === 'none' || Boolean(env[p.api_key_env])
      results.push({
        name: `provider ${p.name}`,
        ok: keyed,
        detail: `${p.base_url}${p.api_key_env === 'none' ? ' (no key needed)' : keyed ? ` (${p.api_key_env} set)` : ` (${p.api_key_env} not set)`}`,
        ...(keyed ? {} : { hint: `set ${p.api_key_env} in the environment — the key never lives in a pipeline` })
      })
    }
    if (!Object.keys(providers).length && existsSync(providersFile)) results.push({ name: 'providers', ok: null, detail: `${providersFile} lists no providers` })
  } catch (err) {
    results.push({ name: 'providers', ok: false, detail: (err as Error).message })
  }

  const journal = env.FLORA_DB ?? join(home, 'flora.db')
  results.push({ name: 'journal', ok: true, detail: `${journal}${existsSync(journal) ? '' : ' (will be created on the first run)'}` })
  return results
}

export function formatProbes(probes: Probe[]): string {
  const mark = (p: Probe): string => (p.ok === true ? '✓' : p.ok === false ? '✗' : '·')
  return probes
    .map((p) => `${mark(p)} ${p.name.padEnd(12)} ${p.detail}${p.hint ? `\n               → ${p.hint}` : ''}`)
    .join('\n')
}

// ── what a failed step should say ──────────────────────────────────────────

/**
 * Turn a harness start-up failure into the sentence a person needs, so a
 * failed step says "codex cannot load its config" instead of leaving them to
 * dig the reason out of the transcript. Only for failures we recognise.
 */
export function explainFailure(harness: string, evidence: Evidence): string | undefined {
  // The api adapter already says what went wrong in one sentence — show it, not a transcript.
  if (harness === 'api' && evidence.exitCode !== 0) return firstLine(evidence.output) || undefined
  const out = evidence.output
  const spawn = /\[spawn error: spawn (\S+) ENOENT\]/.exec(out)
  if (spawn) return `${spawn[1]} is not installed or not on PATH — run \`flora doctor\``

  if (harness === 'codex') {
    const config = /Error loading config(?:uration|\.toml)?:?\s*(.*)/i.exec(out)
    if (config) {
      return `codex cannot load its config (${firstLine(config[1])}) — fix the file or point CODEX_HOME at a working config; \`flora doctor\` shows the state`
    }
    if (/not logged in|unauthorized|401/i.test(out)) return 'codex is not logged in — run `codex login` or set OPENAI_API_KEY'
  }
  if (harness === 'claude-code') {
    if (/not logged in|authentication_failed/i.test(out)) {
      return 'Claude Code is not logged in on this machine — run `claude` and /login, or set ANTHROPIC_API_KEY; `flora doctor` shows the state'
    }
    if (/invalid api key|invalid x-api-key|401/i.test(out)) return 'Claude Code was refused by the API: the key or token is not valid'
  }
  return undefined
}
