import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { floraHome } from './paths'
import type { WorkflowSpec } from './types'
import { loadWorkflow, WorkflowError } from './workflow'
import { MAX_ARCHIVE_BYTES, readZip, writeZip } from './zip'
import { containedPath, validateFileName, validateRelativePath } from './safe-path'

/**
 * A workflow bundle: one `.flora` file (a zip) that carries the workflow and
 * the files it needs — scripts, prompts, tool configs — so it can be dropped
 * into a chat and run on the other side without git, a registry or a
 * shared drive. The folder the workflow lives in is the unit of sharing;
 * inside a run the workflow reaches its own files through {{workflow_dir}}.
 */
export const BUNDLE_FORMAT = 1
export const BUNDLE_EXT = '.flora'
const MANIFEST = 'flora.json'
/** Bigger than this is data, not a workflow; left out unless --include names it. */
const MAX_FILE_BYTES = 8 * 1024 * 1024

export interface BundleFile {
  path: string
  bytes: number
  sha256: string
}

export interface BundleManifest {
  format: number
  name: string
  version?: string | number
  description?: string
  /** Path of the workflow file inside the bundle. */
  workflow: string
  params: Record<string, { required?: boolean; default?: string; description?: string }>
  steps: Array<{ id: string; title?: string; harness: string }>
  harnesses: string[]
  files: BundleFile[]
  packed_at: string
  packed_with: string
}

export interface PackOptions {
  out?: string
  /** Globs (relative to the workflow's directory) to leave out, on top of the defaults. */
  exclude?: string[]
  /** Globs to keep even when a default rule would drop them. */
  include?: string[]
  floraVersion?: string
}

export interface PackResult {
  out: string
  manifest: BundleManifest
  skipped: Array<{ path: string; reason: string }>
  bytes: number
}

/** What is never a workflow's own file: repos, dependencies, run output, journals, bundles. */
const DEFAULT_EXCLUDES = ['.git', 'node_modules', 'run', 'runs', '*.db', '*.db-*', '*.log', '*.bak', '.DS_Store', 'Thumbs.db', `*${BUNDLE_EXT}`, '.env', '.env.*', '.npmrc', '.netrc', '.pypirc', '.git-credentials', '*.key', '*.pem']

export function packWorkflow(workflowPath: string, options: PackOptions = {}): PackResult {
  const file = resolve(workflowPath)
  const spec = loadWorkflow(file)
  const root = dirname(file)
  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])].map(globToRegExp)
  const includes = (options.include ?? []).map(globToRegExp)
  const keep = (rel: string): boolean => includes.some((re) => re.test(rel)) || !excludes.some((re) => re.test(rel))

  const files: Array<{ path: string; data: Buffer; mtime: Date }> = []
  const skipped: PackResult['skipped'] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name)
      const rel = toPosix(relative(root, full))
      if (!keep(rel)) {
        skipped.push({ path: rel, reason: 'excluded' })
        continue
      }
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const info = statSync(full)
      if (info.size > MAX_FILE_BYTES && !includes.some((re) => re.test(rel))) {
        skipped.push({ path: rel, reason: `${formatBytes(info.size)} — larger than ${formatBytes(MAX_FILE_BYTES)}, pass --include to keep it` })
        continue
      }
      files.push({ path: rel, data: readFileSync(full), mtime: info.mtime })
    }
  }
  walk(root)

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    name: spec.name,
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    ...(spec.description ? { description: spec.description } : {}),
    workflow: toPosix(relative(root, file)),
    params: Object.fromEntries(Object.entries(spec.params ?? {}).map(([k, v]) => [k, { ...(v.required ? { required: true } : {}), ...(v.default !== undefined ? { default: v.default } : {}), ...(v.description ? { description: v.description } : {}) }])),
    steps: spec.steps.map((s) => ({ id: s.id, ...(s.title ? { title: s.title } : {}), harness: s.parallel ? 'parallel' : (s.executor?.harness ?? 'command') })),
    harnesses: [...new Set(spec.steps.flatMap((s) => (s.parallel ? s.parallel.branches.map((b) => b.executor.harness) : [s.executor?.harness ?? 'command'])))].sort(),
    files: files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: sha256(f.data) })),
    packed_at: new Date().toISOString(),
    packed_with: `flora ${options.floraVersion ?? 'dev'}`
  }
  const archive = writeZip([
    { name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), mtime: new Date() },
    ...files.map((f) => ({ name: f.path, data: f.data, mtime: f.mtime }))
  ])
  const out = resolve(options.out ?? join(root, `${safeName(spec.name)}${BUNDLE_EXT}`))
  writeFileSync(out, archive)
  return { out, manifest, skipped, bytes: archive.length }
}

export interface Bundle {
  manifest: BundleManifest
  entries: Map<string, Buffer>
}

export function readBundle(path: string): Bundle {
  let archive: Buffer
  try {
    if (statSync(path).size > MAX_ARCHIVE_BYTES) throw new WorkflowError('bundle exceeds the archive size limit')
    archive = readFileSync(path)
  } catch {
    throw new WorkflowError(`cannot read bundle: ${path}`)
  }
  let entries
  try {
    entries = readZip(archive)
  } catch (err) {
    throw new WorkflowError(`${basename(path)} is not a flora bundle: ${(err as Error).message}`)
  }
  const manifestEntry = entries.find((e) => e.name === MANIFEST)
  if (!manifestEntry) throw new WorkflowError(`${basename(path)} is not a flora bundle: no ${MANIFEST} inside`)
  let manifest: BundleManifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as BundleManifest
  } catch {
    throw new WorkflowError(`${basename(path)}: ${MANIFEST} is not valid JSON`)
  }
  if (manifest.format !== BUNDLE_FORMAT) {
    throw new WorkflowError(`${basename(path)} was packed with bundle format ${String(manifest.format)}; this flora reads format ${BUNDLE_FORMAT} — update flora`)
  }
  if (typeof manifest.name !== 'string' || typeof manifest.workflow !== 'string' || !Array.isArray(manifest.files)) throw new WorkflowError(`${basename(path)}: invalid manifest`)
  safeName(manifest.name)
  validateRelativePath(manifest.workflow)
  const map = new Map<string, Buffer>()
  for (const e of entries) if (e.name !== MANIFEST) map.set(e.name, e.data)
  if (!map.has(manifest.workflow)) throw new WorkflowError(`${basename(path)}: the workflow file ${manifest.workflow} is missing from the bundle`)
  const inventory = new Set<string>()
  for (const f of manifest.files) {
    validateRelativePath(f.path)
    if (inventory.has(f.path)) throw new WorkflowError('duplicate manifest inventory path')
    inventory.add(f.path)
    const data = map.get(f.path)
    if (!data) throw new WorkflowError(`${basename(path)}: ${f.path} is listed in ${MANIFEST} but missing`)
    if (data.length !== f.bytes || sha256(data) !== f.sha256) throw new WorkflowError(`${basename(path)}: ${f.path} does not match its checksum — the bundle was altered`)
  }
  if (inventory.size !== map.size || [...map.keys()].some((name) => !inventory.has(name))) throw new WorkflowError('bundle contains files not listed in the manifest inventory')
  return { manifest, entries: map }
}

/** Write a bundle's files under `dir`; every entry has to land inside it. */
export function unpackBundle(bundle: Bundle, dir: string): string {
  const root = resolve(dir)
  mkdirSync(root, { recursive: true })
  for (const [name, data] of bundle.entries) {
    const target = containedPath(root, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
  writeFileSync(containedPath(root, MANIFEST), JSON.stringify(bundle.manifest, null, 2) + '\n')
  return join(root, bundle.manifest.workflow)
}

/** Installed workflows live here, one directory per name. */
export function libraryDir(): string {
  return join(floraHome(), 'workflows')
}

export interface Installed {
  name: string
  dir: string
  workflow: string
  manifest: BundleManifest
}

export function installBundle(path: string, options: { force?: boolean } = {}): Installed {
  const bundle = readBundle(path)
  const dir = containedPath(floraHome(), `workflows/${safeName(bundle.manifest.name)}`)
  if (existsSync(dir)) {
    if (!options.force) throw new WorkflowError(`"${bundle.manifest.name}" is already installed at ${dir} — flora add --force replaces it`)
    rmSync(dir, { recursive: true, force: true })
  }
  const workflow = unpackBundle(bundle, dir)
  return { name: bundle.manifest.name, dir, workflow, manifest: bundle.manifest }
}

export function removeInstalled(name: string): boolean {
  const dir = containedPath(floraHome(), `workflows/${safeName(name)}`)
  if (!existsSync(join(dir, MANIFEST))) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

export function listInstalled(): Installed[] {
  const lib = libraryDir()
  if (!existsSync(lib)) return []
  const out: Installed[] = []
  for (const entry of readdirSync(lib, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let dir: string
    try { dir = containedPath(lib, entry.name) } catch { continue }
    const manifestPath = join(dir, MANIFEST)
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest
      safeName(manifest.name)
      out.push({ name: manifest.name, dir, workflow: containedPath(dir, manifest.workflow), manifest })
    } catch {
      // A half-written install is not a workflow; leave it to the human.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function isBundlePath(ref: string): boolean {
  return extname(ref).toLowerCase() === BUNDLE_EXT || extname(ref).toLowerCase() === '.zip'
}

/**
 * What `flora run <ref>` should load: a workflow file as given, a bundle
 * unpacked into a content-addressed cache (the same bundle twice unpacks
 * once), or an installed workflow by name.
 */
export function resolveWorkflowRef(ref: string): { workflow: string; kind: 'file' | 'bundle' | 'installed'; manifest?: BundleManifest } {
  if (isBundlePath(ref) && existsSync(ref)) {
    const bundle = readBundle(ref)
    const key = `${safeName(bundle.manifest.name)}-${sha256(readFileSync(ref)).slice(0, 12)}`
    const dir = containedPath(floraHome(), `bundles/${key}`)
    const workflow = existsSync(join(dir, MANIFEST)) ? join(dir, bundle.manifest.workflow) : unpackBundle(bundle, dir)
    return { workflow, kind: 'bundle', manifest: bundle.manifest }
  }
  if (existsSync(ref) && statSync(ref).isFile()) return { workflow: ref, kind: 'file' }
  const installed = listInstalled().find((i) => i.name === ref || safeName(i.name) === safeName(ref))
  if (installed) return { workflow: installed.workflow, kind: 'installed', manifest: installed.manifest }
  const hint = listInstalled().length ? ` (installed: ${listInstalled().map((i) => i.name).join(', ')})` : ''
  throw new WorkflowError(`no workflow file, bundle or installed workflow "${ref}"${hint}`)
}

/** Human-readable description of a bundle, for `flora inspect`. */
export function describeBundle(manifest: BundleManifest, source?: string): string {
  const lines: string[] = []
  lines.push(`${manifest.name}${manifest.version !== undefined ? ` · v${String(manifest.version)}` : ''}${source ? `  (${source})` : ''}`)
  if (manifest.description) lines.push(`  ${manifest.description}`)
  lines.push(`  packed ${manifest.packed_at.slice(0, 16).replace('T', ' ')} with ${manifest.packed_with}`)
  lines.push('')
  const params = Object.entries(manifest.params)
  lines.push(`params: ${params.length ? '' : 'none'}`)
  for (const [name, def] of params) {
    lines.push(`  ${name.padEnd(14)} ${def.required ? 'required' : def.default !== undefined ? `default ${JSON.stringify(def.default)}` : 'optional'}${def.description ? `  — ${def.description}` : ''}`)
  }
  lines.push(`steps (${manifest.steps.length}):`)
  for (const s of manifest.steps) lines.push(`  ${s.id.padEnd(14)} ${s.harness.padEnd(12)} ${s.title ?? ''}`.trimEnd())
  lines.push(`needs: ${manifest.harnesses.join(', ')}`)
  lines.push(`files (${manifest.files.length}, ${formatBytes(manifest.files.reduce((s, f) => s + f.bytes, 0))}):`)
  for (const f of manifest.files) lines.push(`  ${f.path.padEnd(40)} ${formatBytes(f.bytes).padStart(9)}`)
  return lines.join('\n')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function safeName(name: string): string {
  const result = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'
  validateFileName(result)
  return result
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/** `*` within a segment, `**` across segments; a bare name matches at any depth. */
function globToRegExp(glob: string): RegExp {
  let escaped = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') { escaped += '(?:.*/)?'; i++ }
      else escaped += '.*'
    } else if (char === '*') escaped += '[^/]*'
    else if (char === '?') escaped += '[^/]'
    else escaped += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(glob.includes('/') ? `^${escaped}(?:/.*)?$` : `(?:^|/)${escaped}(?:/.*)?$`)
}

/** Type guard used by the CLI to print the workflow's own name when packing. */
export function specName(spec: WorkflowSpec): string {
  return spec.name
}
