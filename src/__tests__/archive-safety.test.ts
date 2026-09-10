import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readBundle, safeName } from '../bundle'
import { exportRun, readRunFile } from '../runfile'
import { RunStore } from '../state'
import { readZip, writeZip } from '../zip'
import type { RunRecord } from '../types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-safety-'))
  vi.stubEnv('FLORA_HOME', dir)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

it.each(['.', '..', 'CON', 'aux.txt', 'name.'])('rejects unsafe installation name %s', (name) => {
  expect(() => safeName(name)).toThrow(/unsafe|invalid/i)
})

const record = (runId: string): RunRecord => ({ runId, workflow: 'test', cwd: dir, params: {}, status: 'passed', startedAt: new Date().toISOString(), steps: [] })
it.each(['../escape', '..', 'C:\\escape', 'name:stream'])('refuses imported run ID %s before writing to disk', (id) => {
  const file = join(dir, 'bad.flora-run')
  writeFileSync(file, writeZip([
    { name: 'flora-run.json', data: Buffer.from('{"format":1}') },
    { name: 'run.json', data: Buffer.from(JSON.stringify(record(id))) }
  ]))
  expect(() => readRunFile(file)).toThrow(/run|path|invalid/i)
})

it('refuses artifact traversal in a journal record during export', () => {
  const run = record('test-run')
  run.steps.push({ stepId: 's', attempt: 1, status: 'passed', checks: [], artifacts: [{ path: '../../../secret.txt', source: 'secret', bytes: 6 }] })
  writeFileSync(join(dir, 'secret.txt'), 'secret')
  mkdirSync(join(dir, 'runs', run.runId, 'artifacts'), { recursive: true })
  const store = new RunStore(join(dir, 'flora.db'))
  try {
    store.save(run)
    expect(() => exportRun(store, run.runId, { out: join(dir, 'export.flora-run') })).toThrow(/artifact|path|invalid/i)
    expect(readFileSync(join(dir, 'secret.txt'), 'utf8')).toBe('secret')
  } finally { store.close() }
})

it('limits actual inflation even when a zip lies about its uncompressed size', () => {
  const zip = writeZip([{ name: 'large', data: Buffer.alloc(4096, 65) }])
  expect(() => readZip(zip, { maxEntryBytes: 32 })).toThrow(/limit/)
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  zip.writeUInt32LE(1, central + 24)
  expect(() => readZip(zip, { maxEntryBytes: 32 })).toThrow()
})

it('rejects archive entries missing from the signed file inventory', () => {
  const file = join(dir, 'bad.flora')
  const manifest = { format: 1, name: 'demo', workflow: 'main.yaml', files: [] }
  writeFileSync(file, writeZip([
    { name: 'flora.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'main.yaml', data: Buffer.from('name: demo') }
  ]))
  expect(() => readBundle(file)).toThrow(/inventory|listed|manifest/i)
})
