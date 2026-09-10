import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRecorder } from '../recorder'
import { effectiveStatus, RunStore, STALE_RUN_MS } from '../state'
import { startServer, type RunningServer } from '../web/server'
import type { RunRecord } from '../types'

const run = promisify(execFile)
const BIN = join(process.cwd(), 'bin', 'flora.mjs')
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-interrupted-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const dead = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'dead-run',
  workflow: 'nightly-pipeline',
  cwd: dir,
  params: {},
  status: 'running',
  startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  steps: [
    { stepId: 'ingest', attempt: 1, status: 'passed', checks: [], evidence: { output: 'ok', exitCode: 0, durationMs: 5 } },
    { stepId: 'filter', attempt: 1, status: 'running', checks: [] }
  ],
  ...over
})

describe('interrupted runs', () => {
  it('a running run with a stale heartbeat reads as interrupted; a fresh one as running', () => {
    const now = Date.now()
    expect(effectiveStatus({ status: 'running', startedAt: new Date(now - STALE_RUN_MS - 1).toISOString() }, now)).toBe('interrupted')
    expect(effectiveStatus({ status: 'running', startedAt: new Date(now - 10 * 60_000).toISOString(), heartbeatAt: new Date(now - 5_000).toISOString() }, now)).toBe('running')
    expect(effectiveStatus({ status: 'passed', startedAt: new Date(now - 10 * 60_000).toISOString() }, now)).toBe('passed')
  })

  it('the sweep marks them in the journal, fails the step that was running, and leaves live runs alone', () => {
    const store = new RunStore(join(dir, 'flora.db'))
    // save() stamps a fresh heartbeat, so age the row the way a dead process leaves it.
    store.save(dead())
    store.save(dead({ runId: 'live-run', startedAt: new Date().toISOString() }))
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
    db.prepare('UPDATE runs SET heartbeat_at = ? WHERE run_id = ?').run(new Date(Date.now() - 3 * 60_000).toISOString(), 'dead-run')

    expect(store.sweepInterrupted()).toBe(1)
    const marked = store.load('dead-run')!
    expect(marked.status).toBe('interrupted')
    expect(marked.finishedAt).toBeTruthy()
    expect(marked.steps[1]).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') })
    expect(marked.steps[0].status).toBe('passed')
    expect(store.load('live-run')!.status).toBe('running')
    expect(store.list().map((r) => [r.runId, r.status])).toEqual([
      ['live-run', 'running'],
      ['dead-run', 'interrupted']
    ])
    expect(store.sweepInterrupted()).toBe(0)
    store.close()
  })

  it('the recorder keeps a heartbeat while a run is going', async () => {
    const store = new RunStore(join(dir, 'flora.db'))
    const recorder = createRecorder(store, { cwd: dir, params: {} })
    recorder.write({ type: 'run_start', runId: 'beating', workflow: 'w', steps: 1 })
    const first = store.list().find((r) => r.runId === 'beating')!.heartbeatAt
    expect(first).toBeTruthy()
    await new Promise((r) => setTimeout(r, 20))
    store.heartbeat('beating')
    expect(store.list().find((r) => r.runId === 'beating')!.heartbeatAt! >= first!).toBe(true)
    recorder.write({ type: 'run_end', status: 'passed' })
    recorder.close()
    store.close()
  })

  it('flora runs shows the dead run as interrupted', { timeout: 60_000 }, async () => {
    const store = new RunStore(join(dir, 'flora.db'))
    store.save(dead())
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
    db.prepare('UPDATE runs SET heartbeat_at = ? WHERE run_id = ?').run(new Date(Date.now() - 3 * 60_000).toISOString(), 'dead-run')
    store.close()
    const { stdout } = await run(process.execPath, [BIN, 'runs'], { cwd: process.cwd(), env: { ...process.env, FLORA_DB: join(dir, 'flora.db') } })
    expect(plain(stdout)).toMatch(/interrupted\s+\S+\s+nightly-pipeline/)
  })

  it('the viewer shows it as interrupted without writing', async () => {
    const store = new RunStore(join(dir, 'flora.db'))
    store.save(dead())
    const db = (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
    db.prepare('UPDATE runs SET heartbeat_at = ? WHERE run_id = ?').run(new Date(Date.now() - 3 * 60_000).toISOString(), 'dead-run')
    store.close()
    let server: RunningServer | undefined
    try {
      server = await startServer({ port: 0, dbPath: join(dir, 'flora.db') })
      const get = (path: string) =>
        new Promise<unknown>((ok, fail) => {
          request(`${server!.url}${path}`, (r) => {
            let body = ''
            r.on('data', (c) => (body += c))
            r.on('end', () => ok(JSON.parse(body)))
          })
            .on('error', fail)
            .end()
        })
      const list = (await get('/api/runs')) as Array<{ runId: string; status: string; finishedAt?: string }>
      expect(list[0]).toMatchObject({ runId: 'dead-run', status: 'interrupted' })
      expect(list[0].finishedAt).toBeTruthy()
      const record = (await get('/api/runs/dead-run')) as { status: string }
      expect(record.status).toBe('interrupted')
      const again = new RunStore(join(dir, 'flora.db'))
      expect(again.load('dead-run')!.status).toBe('running') // the viewer never writes
      again.close()
    } finally {
      await server?.close()
    }
  })
})

describe('journal index', () => {
  it('a renamed workflow reaches the run list, not only the record', () => {
    const store = new RunStore(join(dir, 'flora.db'))
    store.save(dead({ runId: 'r-name', status: 'passed', finishedAt: new Date().toISOString(), workflow: 'old-name' }))
    const record = store.load('r-name')!
    record.workflow = 'new-name'
    store.save(record)
    expect(store.list().find((r) => r.runId === 'r-name')?.workflow).toBe('new-name')
    store.close()
  })
})
