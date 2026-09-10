import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderRunReport } from '../report'
import { exportRun, importRun, readRunFile } from '../runfile'
import { RunStore } from '../state'
import { startServer, type RunningServer } from '../web/server'
import type { RunRecord } from '../types'

const run = promisify(execFile)
const BIN = join(process.cwd(), 'bin', 'flora.mjs')
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-runfile-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const flora = (args: string[], home: string) =>
  run(process.execPath, [BIN, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, FLORA_HOME: home, FLORA_DB: join(home, 'flora.db') }
  }).then((r) => ({ ...r, stdout: plain(r.stdout) }))

const record: RunRecord = {
  runId: 'run-report-1',
  workflow: 'review-then-fix',
  cwd: '/work/repo',
  params: { task: 'fix the flaky retry' },
  status: 'failed',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:12.000Z',
  steps: [
    {
      stepId: 'implement',
      title: 'Implement the change',
      harness: 'claude-code',
      attempt: 2,
      status: 'passed',
      evidence: { output: 'edited 2 files', exitCode: 0, durationMs: 8200, costUsd: 0.0412, usage: { inputTokens: 1200, outputTokens: 340 } },
      checks: [{ check: { type: 'command', run: 'git diff --stat --exit-code', expect_exit: 1 }, passed: true, detail: 'exit 1' }],
      output: { files: 2 },
      priorAttempts: [{ attempt: 1, status: 'failed', evidence: { durationMs: 3000, exitCode: 1, costUsd: 0.01 } }]
    },
    {
      stepId: 'review',
      harness: 'codex',
      attempt: 1,
      status: 'failed',
      evidence: { output: 'DEFECT_FOUND\n```\nfenced\n```', exitCode: 0, durationMs: 3300 },
      checks: [{ check: { type: 'artifact', path: 'REVIEW.md' }, passed: false, detail: 'REVIEW.md does not exist' }],
      error: 'REVIEW.md does not exist'
    },
    { stepId: 'deploy', attempt: 0, status: 'skipped', checks: [], skipReason: 'steps.review.status == passed' }
  ]
}

describe('run report', () => {
  it('reads as a document: meta, usage, every step with checks, output and executor output', () => {
    const text = renderRunReport(record, { version: '0.1.0' })
    expect(text).toContain('# review-then-fix — failed')
    expect(text).toContain('| Parameters | `task=fix the flaky retry` |')
    expect(text).toContain('Stopped at **review**: REVIEW.md does not exist.')
    expect(text).toContain('| implement | 2 | – | 1,200 | 340 | 1,540 | $0.0512 |')
    expect(text).toContain('### ✓ implement — Implement the change')
    expect(text).toContain('attempt 2 (retried)')
    expect(text).toContain('Earlier attempts: #1 failed (3.0s, $0.0100)')
    expect(text).toContain('- ✓ `git diff --stat --exit-code` (exit 1) — exit 1')
    expect(text).toContain('- ✗ artifact REVIEW.md — REVIEW.md does not exist')
    expect(text).toContain('"files": 2')
    expect(text).toContain('### – deploy')
    expect(text).toContain('Skipped — when: `steps.review.status == passed`')
    // A fence inside executor output must not break the report's own fence.
    expect(text).toContain('````text\nDEFECT_FOUND\n```\nfenced\n```\n````')
    expect(text).toContain('flora 0.1.0 · run report')
  })
})

describe('artifacts, export and import', () => {
  it('every run leaves run.json and report.md; --report copies the document', { timeout: 90_000 }, async () => {
    const home = join(dir, 'home')
    mkdirSync(home)
    const { stdout } = await flora(['run', 'examples/hello.yaml', '--cwd', dir, '--report', join(dir, 'reports')], home)
    expect(stdout).toContain('run passed')
    const runId = /report .*[\\/]runs[\\/]([0-9a-f-]{36})[\\/]report\.md/.exec(stdout)?.[1]
    expect(runId).toBeTruthy()
    const artifacts = join(home, 'runs', runId!)
    expect(existsSync(join(artifacts, 'run.json'))).toBe(true)
    const report = readFileSync(join(artifacts, 'report.md'), 'utf8')
    expect(report).toContain('# hello — passed')
    expect(readFileSync(join(dir, 'reports', `hello-${runId!.slice(0, 8)}.md`), 'utf8')).toBe(report)

    const { stdout: printed } = await flora(['report', runId!.slice(0, 8)], home)
    expect(printed).toContain('# hello — passed')
  })

  it('a .flora-run file carries the record, the events and the report into another journal', { timeout: 90_000 }, async () => {
    const home = join(dir, 'home')
    const other = join(dir, 'other')
    mkdirSync(home)
    mkdirSync(other)
    await flora(['run', 'examples/hello.yaml', '--cwd', dir], home)
    const out = join(dir, 'hello.flora-run')
    const { stdout: exported } = await flora(['export', 'latest', '--out', out], home)
    expect(exported).toContain('hello.flora-run')
    const file = readRunFile(out)
    expect(file.record.workflow).toBe('hello')
    expect(file.events.some((e) => e.type === 'run_end')).toBe(true)
    expect(file.report).toContain('# hello — passed')

    const { stdout: imported } = await flora(['import', out], other)
    expect(imported).toContain('imported')
    const { stdout: runs } = await flora(['runs'], other)
    expect(runs).toContain('hello')
    expect(runs).toContain(file.record.runId)
    await expect(flora(['import', out], other)).rejects.toMatchObject({ stderr: expect.stringContaining('already in the journal') })
    const { stdout: replaced } = await flora(['import', out, '--force'], other)
    expect(replaced).toContain('replaced')

    const store = new RunStore(join(other, 'flora.db'))
    expect(store.load(file.record.runId)?.status).toBe('passed')
    expect(store.readEvents(file.record.runId).length).toBe(file.events.length)
    store.close()
  })

  it('refuses a file that is not a run file', () => {
    const store = new RunStore(join(dir, 'flora.db'))
    store.save(record)
    expect(() => exportRun(store, 'no-such-run')).toThrow(/no run "no-such-run"/)
    const { out } = exportRun(store, record.runId, { out: join(dir, 'r.flora-run') })
    expect(() => importRun(store, out)).toThrow(/already in the journal/)
    expect(() => importRun(store, join(dir, 'nope.flora-run'))).toThrow(/cannot read run file/)
    store.close()
  })
})

describe('viewer', () => {
  let server: RunningServer
  afterEach(() => server?.close())

  it('serves the report as a markdown download', async () => {
    const store = new RunStore(join(dir, 'flora.db'))
    store.save(record)
    store.close()
    server = await startServer({ port: 0, dbPath: join(dir, 'flora.db') })
    const res = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
      request(`${server.url}/api/runs/${record.runId}/report.md`, (r) => {
        let body = ''
        r.on('data', (c) => (body += c))
        r.on('end', () => ok({ status: r.statusCode ?? 0, headers: r.headers, body }))
      })
        .on('error', fail)
        .end()
    })
    expect(res.status).toBe(200)
    expect(String(res.headers['content-type'])).toContain('text/markdown')
    expect(String(res.headers['content-disposition'])).toContain('review-then-fix-run-repo.md')
    expect(res.body).toContain('# review-then-fix — failed')
  })
})
