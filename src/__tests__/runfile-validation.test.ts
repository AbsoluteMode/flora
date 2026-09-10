import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { importRun, readRunFile } from '../runfile'
import { RunStore } from '../state'
import { writeZip } from '../zip'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flora-run-validation-')); vi.stubEnv('FLORA_HOME', dir) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
const record = () => ({ runId: 'imported', workflow: 'test', cwd: dir, params: {}, status: 'passed', startedAt: new Date().toISOString(), steps: [{ stepId: 's', status: 'passed', attempt: 1, checks: [] }] })
function archive(run: unknown, events: unknown[] = []): string {
  const file = join(dir, 'input.flora-run')
  writeFileSync(file, writeZip([
    { name: 'flora-run.json', data: Buffer.from('{"format":1}') },
    { name: 'run.json', data: Buffer.from(JSON.stringify(run)) },
    { name: 'events.jsonl', data: Buffer.from(events.map((e) => JSON.stringify(e)).join('\n')) }
  ]))
  return file
}

it.each([
  ['invalid status', () => ({ ...record(), status: 'made-up' })],
  ['object title', () => ({ ...record(), workflow: { title: 'x' } })],
  ['invalid metrics', () => ({ ...record(), steps: [{ ...record().steps[0], metrics: { count: 'text' } }] })],
  ['invalid cost', () => ({ ...record(), steps: [{ ...record().steps[0], evidence: { output: '', exitCode: 0, durationMs: 0, costUsd: 'bad' } }] })],
  ['invalid branches', () => ({ ...record(), steps: [{ ...record().steps[0], branches: [{ nope: true }] }] })]
])('rejects %s before the journal is modified', (_name, make) => {
  const store = new RunStore(join(dir, 'flora.db'))
  try {
    expect(() => importRun(store, archive(make()))).toThrow(/invalid run/)
    expect(store.list()).toEqual([])
  } finally { store.close() }
})

it('rejects event names that can inject SSE fields', () => {
  expect(() => readRunFile(archive(record(), [{ seq: 1, at: 'now', type: 'run_end\ndata: fake', payload: {} }]))).toThrow(/invalid.*event/)
})
