import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { FLORA_BIN } from './tools'

/**
 * The pre-push gate: a git hook that runs a workflow before every push and
 * lets `flora run`'s exit code decide. A failed contract blocks the push and
 * the run's output — steps, checks, the reason — is what the user sees.
 */
export const GATE_MARKER = '# installed by flora gate'

export interface GateStatus {
  hookPath: string
  /** A pre-push hook exists. */
  installed: boolean
  /** …and it is ours. */
  ours: boolean
  workflow?: string
  floraBin?: string
  /** Why the installed hook would not work any more. */
  stale?: string
}

/** Forward slashes everywhere: sh reads the hook, and Windows accepts them too. */
const shPath = (p: string): string => resolve(p).replace(/\\/g, '/')
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'"'"'`)}'`

function metadata(text: string, field: string): string | undefined {
  const value = new RegExp(`^# flora-gate ${field}: (.+)$`, 'm').exec(text)?.[1]
  if (!value || !value.startsWith('"')) return value // previously installed hooks
  try { const decoded: unknown = JSON.parse(value); return typeof decoded === 'string' ? decoded : undefined }
  catch { return undefined }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}

/** Where git expects hooks for this repository (`core.hooksPath` honoured). */
export function hooksDir(repo: string): string {
  let custom = ''
  try {
    custom = git(repo, ['config', '--get', 'core.hooksPath'])
  } catch {
    // not set
  }
  if (custom) return isAbsolute(custom) ? custom : resolve(repo, custom)
  return resolve(repo, git(repo, ['rev-parse', '--git-path', 'hooks']))
}

export function hookScript(repo: string, workflow: string, floraBin: string): string {
  return [
    '#!/bin/sh',
    `${GATE_MARKER} — a failed run blocks the push; \`flora gate uninstall\` removes this hook`,
    `# flora-gate workflow: ${JSON.stringify(shPath(workflow))}`,
    `# flora-gate bin: ${JSON.stringify(shPath(floraBin))}`,
    `# flora-gate node: ${JSON.stringify(shPath(process.execPath))}`,
    `exec ${shellQuote(shPath(process.execPath))} ${shellQuote(shPath(floraBin))} run ${shellQuote(shPath(workflow))} --cwd ${shellQuote(shPath(repo))} --param "remote=$1" --param "url=$2"`,
    ''
  ].join('\n')
}

export function gateStatus(repo: string): GateStatus {
  const hookPath = join(hooksDir(repo), 'pre-push')
  if (!existsSync(hookPath)) return { hookPath, installed: false, ours: false }
  const text = readFileSync(hookPath, 'utf8')
  if (!text.startsWith(`#!/bin/sh\n${GATE_MARKER}`) && !text.startsWith(`#!/bin/sh\r\n${GATE_MARKER}`)) return { hookPath, installed: true, ours: false }
  const workflow = metadata(text, 'workflow')
  const floraBin = metadata(text, 'bin')
  const node = metadata(text, 'node')
  let stale: string | undefined
  if (!workflow || !floraBin) stale = 'the hook metadata is incomplete — run `flora gate install` again'
  else if (node && !existsSync(node)) stale = `the Node runtime is gone: ${node} — run \`flora gate install\` again`
  else if (floraBin && !existsSync(floraBin)) stale = `flora is no longer at ${floraBin} — run \`flora gate install\` again`
  else if (workflow && !existsSync(workflow)) stale = `the workflow file is gone: ${workflow}`
  return { hookPath, installed: true, ours: true, workflow, floraBin, ...(stale ? { stale } : {}) }
}

/**
 * Write the hook. Refuses to overwrite a hook that is not ours — chaining
 * someone else's pre-push is their call, not something to do silently.
 */
export function gateInstall(repo: string, workflow: string, floraBin: string = FLORA_BIN): GateStatus {
  const workflowPath = resolve(repo, workflow)
  if (!existsSync(workflowPath)) throw new Error(`workflow not found: ${workflowPath}`)
  const current = gateStatus(repo)
  if (current.installed && !current.ours) {
    throw new Error(`a pre-push hook already exists and is not flora's: ${current.hookPath} — remove it, or chain flora from it yourself`)
  }
  mkdirSync(hooksDir(repo), { recursive: true })
  writeFileSync(current.hookPath, hookScript(repo, workflowPath, floraBin), { encoding: 'utf8' })
  chmodSync(current.hookPath, 0o755)
  return gateStatus(repo)
}

/** Remove our hook; true if there was one. A foreign hook is left alone. */
export function gateUninstall(repo: string): boolean {
  const current = gateStatus(repo)
  if (!current.installed) return false
  if (!current.ours) throw new Error(`the pre-push hook at ${current.hookPath} is not flora's — leaving it alone`)
  rmSync(current.hookPath)
  return true
}
