import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { floraHome } from './paths'
import { renderRunReport } from './report'
import type { RunStore, StoredEvent } from './state'
import type { RunRecord } from './types'
import { WorkflowError } from './workflow'
import { MAX_ARCHIVE_BYTES, readZip, writeZip } from './zip'
import { containedPath, validateFileName, validateRelativePath } from './safe-path'
import { validateRunEvent, validateRunRecord } from './runfile-schema'

/**
 * A run outside the journal. Two shapes:
 *
 * - the per-run artifact directory `<flora home>/runs/<runId>/` gets
 *   `run.json` (the record, verbatim) and `report.md` (the record as a
 *   document) after every run, next to the branch patches that already
 *   live there — the journal is a database, this is something you can open;
 * - `flora export` packs the same plus the live event log into one
 *   `.flora-run` file (a zip), and `flora import` puts it into another
 *   machine's journal, where the viewer shows it like a local run.
 */
export const RUN_FILE_EXT = '.flora-run'
export const RUN_FILE_FORMAT = 1

export interface RunArtifacts {
  dir: string
  record: string
  report: string
}

export function runArtifactsDir(runId: string): string {
  validateFileName(runId)
  return containedPath(floraHome(), `runs/${runId}`)
}

/** Write `run.json` and `report.md` for a run; returns where they went. */
export function writeRunArtifacts(record: RunRecord, options: { dir?: string; version?: string } = {}): RunArtifacts {
  const dir = options.dir ?? runArtifactsDir(record.runId)
  mkdirSync(dir, { recursive: true })
  const recordPath = join(dir, 'run.json')
  const reportPath = join(dir, 'report.md')
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
  writeFileSync(reportPath, renderRunReport(record, { version: options.version }))
  return { dir, record: recordPath, report: reportPath }
}

export interface RunFile {
  format: number
  record: RunRecord
  events: StoredEvent[]
  report: string
  /** Declared step artifacts carried in the file, by their path under the run's artifact directory. */
  artifacts: Array<{ path: string; data: Buffer }>
}

export function exportRun(store: RunStore, runId: string, options: { out?: string; version?: string } = {}): { out: string; bytes: number; events: number; artifacts: number } {
  const record = store.load(runId)
  if (!record) throw new WorkflowError(`no run "${runId}" in the journal — flora runs lists them`)
  const events: StoredEvent[] = []
  let cursor = 0
  for (;;) {
    const page = store.readEvents(runId, cursor, 1000)
    if (!page.length) break
    events.push(...page)
    cursor = page[page.length - 1].seq
  }
  const report = renderRunReport(record, { version: options.version })
  // The steps' declared artifacts (prompts, answers, logs) travel too, from the run's artifact directory.
  const artifactRoot = containedPath(runArtifactsDir(record.runId), 'artifacts')
  const files: Array<{ name: string; data: Buffer }> = []
  let missing = 0
  for (const step of record.steps) {
    for (const a of [...(step.artifacts ?? []), ...(step.branches ?? []).flatMap((b) => b.artifacts ?? [])]) {
      const file = containedPath(artifactRoot, a.path)
      if (!existsSync(file)) {
        missing++
        continue
      }
      files.push({ name: `artifacts/${a.path}`, data: readFileSync(file) })
    }
  }
  const meta = { format: RUN_FILE_FORMAT, run_id: record.runId, workflow: record.workflow, status: record.status, started_at: record.startedAt, exported_at: new Date().toISOString(), exported_with: `flora ${options.version ?? 'dev'}`, events: events.length, artifacts: files.length, artifacts_missing: missing }
  const archive = writeZip([
    { name: 'flora-run.json', data: Buffer.from(JSON.stringify(meta, null, 2) + '\n') },
    { name: 'run.json', data: Buffer.from(JSON.stringify(record, null, 2) + '\n') },
    { name: 'events.jsonl', data: Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')) },
    { name: 'report.md', data: Buffer.from(report) },
    ...files
  ])
  const out = resolve(options.out ?? `${safe(record.workflow)}-${record.runId.slice(0, 8)}${RUN_FILE_EXT}`)
  writeFileSync(out, archive)
  return { out, bytes: archive.length, events: events.length, artifacts: files.length }
}

export function readRunFile(path: string): RunFile {
  let archive: Buffer
  try {
    if (statSync(path).size > MAX_ARCHIVE_BYTES) throw new WorkflowError('run file exceeds the archive size limit')
    archive = readFileSync(path)
  } catch {
    throw new WorkflowError(`cannot read run file: ${path}`)
  }
  let entries
  try {
    entries = readZip(archive)
  } catch (err) {
    throw new WorkflowError(`${basename(path)} is not a flora run file: ${(err as Error).message}`)
  }
  const get = (name: string): Buffer | undefined => entries.find((e) => e.name === name)?.data
  const meta = get('flora-run.json')
  const recordData = get('run.json')
  if (!meta || !recordData) throw new WorkflowError(`${basename(path)} is not a flora run file: flora-run.json or run.json missing`)
  const format = (JSON.parse(meta.toString('utf8')) as { format?: number }).format
  if (format !== RUN_FILE_FORMAT) throw new WorkflowError(`${basename(path)} uses run-file format ${String(format)}; this flora reads format ${RUN_FILE_FORMAT} — update flora`)
  const record = validateRunRecord(JSON.parse(recordData.toString('utf8')))
  const events = (get('events.jsonl')?.toString('utf8') ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => validateRunEvent(JSON.parse(l)))
  const artifacts = entries.filter((e) => e.name.startsWith('artifacts/')).map((e) => ({ path: e.name.slice('artifacts/'.length), data: e.data }))
  return { format, record, events, report: get('report.md')?.toString('utf8') ?? '', artifacts }
}

export function importRun(store: RunStore, path: string, options: { force?: boolean } = {}): { record: RunRecord; events: number; replaced: boolean; artifacts: number } {
  const file = readRunFile(path)
  const existing = store.load(file.record.runId)
  if (existing && !options.force) throw new WorkflowError(`run ${file.record.runId} is already in the journal — flora import --force replaces it`)
  const root = containedPath(runArtifactsDir(file.record.runId), 'artifacts')
  const targets = file.artifacts.map((a) => ({ ...a, target: containedPath(root, a.path) }))
  // Resolve every destination before mutating the journal or materializing files.
  for (const a of targets) {
    mkdirSync(dirname(a.target), { recursive: true })
    writeFileSync(a.target, a.data)
  }
  store.save(file.record)
  // The event log is append-only per run; an import keeps the exporter's order.
  if (!existing || !store.readEvents(file.record.runId, 0, 1).length) {
    store.appendEvents(file.record.runId, file.events.map((e) => ({ at: e.at, type: e.type, payload: e.payload })))
  }
  // The artifacts land where the viewer looks for them; every path has to stay inside.
  return { record: file.record, events: file.events.length, replaced: Boolean(existing), artifacts: file.artifacts.length }
}

export function isRunFilePath(ref: string): boolean {
  return ref.toLowerCase().endsWith(RUN_FILE_EXT) && existsSync(ref)
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}
