import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunStore } from '../state'
import { HOST, startServer, type RunningServer } from '../web/server'
import type { RunRecord } from '../types'

let dir: string
let server: RunningServer
let base: string

const record: RunRecord = {
  runId: 'run-1',
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
      evidence: { output: 'done', exitCode: 0, durationMs: 8200, costUsd: 0.0412 },
      checks: [{ check: { type: 'command', run: 'git diff --stat --exit-code', expect_exit: 1 }, passed: true, detail: 'exit 1' }]
    },
    {
      stepId: 'review',
      harness: 'codex',
      attempt: 1,
      status: 'failed',
      evidence: { output: 'DEFECT_FOUND', exitCode: 0, durationMs: 3300 },
      checks: [{ check: { type: 'artifact', path: 'REVIEW.md' }, passed: false, detail: 'REVIEW.md does not exist' }]
    }
  ]
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flora-web-'))
  const store = new RunStore(join(dir, 'flora.db'))
  store.save(record)
  store.close()
  server = await startServer({ port: 0, dbPath: join(dir, 'flora.db') })
  base = server.url
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('viewer api', () => {
  it('lists runs from the journal', async () => {
    const response = await fetch(`${base}/api/runs`)
    expect(response.status).toBe(200)
    const runs = (await response.json()) as Array<Record<string, unknown>>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ runId: 'run-1', workflow: 'review-then-fix', status: 'failed' })
    expect(runs[0].finishedAt).toBe('2026-01-01T00:00:12.000Z')
  })

  it('returns the full record for one run, executor included', async () => {
    const run = (await (await fetch(`${base}/api/runs/run-1`)).json()) as RunRecord
    expect(run.steps).toHaveLength(2)
    expect(run.steps[0].harness).toBe('claude-code')
    expect(run.steps[0].evidence?.costUsd).toBe(0.0412)
    expect(run.steps[1].checks[0].detail).toContain('does not exist')
  })

  it('404s an unknown run and an unknown endpoint as JSON', async () => {
    const missing = await fetch(`${base}/api/runs/nope`)
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toBe('no such run')
    expect((await fetch(`${base}/api/elsewhere`)).status).toBe(404)
  })

  it('refuses anything that is not a read', async () => {
    const response = await fetch(`${base}/api/runs`, { method: 'DELETE' })
    expect(response.status).toBe(405)
  })
})

describe('viewer statics', () => {
  it('serves the app shell at the root', async () => {
    const response = await fetch(base)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<title>flora')
  })

  it('falls back to the shell for a deep link so /runs/:id reloads', async () => {
    const response = await fetch(`${base}/runs/run-1`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>flora')
  })

  it('resolves every asset the shell references from a deep link', async () => {
    // Relative hrefs would resolve against /runs/, so a reloaded run page would
    // come up unstyled and scriptless.
    const shell = await (await fetch(`${base}/runs/run-1`)).text()
    const refs = [...shell.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((ref) => /\.\w+$/.test(ref)) // asset files, not the nav links
    expect(refs).toEqual(['/styles.css', '/step-inspector.css', '/help.md', '/help.ru.md', '/app.js'])
    for (const ref of refs) {
      const asset = await fetch(new URL(ref, `${base}/runs/run-1`))
      expect(`${ref} -> ${asset.status}`).toBe(`${ref} -> 200`)
      expect(`${ref} -> ${asset.headers.get('content-type')}`).not.toContain('text/html')
    }
  })

  it('serves a real asset with its own content type', async () => {
    const response = await fetch(`${base}/styles.css`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/css')
  })

  it('does not escape the web root', async () => {
    // Encoded so the client cannot normalise the traversal away before it is sent.
    const response = await fetch(`${base}/%2e%2e/package.json`)
    const body = await response.text()
    expect(body).not.toContain('"name": "flora"')
  })
})

describe('viewer is local-only', () => {
  it('listens on loopback', () => {
    const address = server.server.address()
    expect(typeof address === 'object' && address?.address).toBe(HOST)
  })

  it('rejects a request carrying a foreign Host header', async () => {
    // A page on evil.com can point its own name at 127.0.0.1; the Host header
    // is what gives the rebinding away. fetch() refuses to set Host, so this
    // goes out over a raw request.
    const status = await new Promise<number>((ok, fail) => {
      const req = request(
        { host: HOST, port: server.port, path: '/api/runs', headers: { host: 'evil.example' } },
        (res) => {
          res.resume()
          ok(res.statusCode ?? 0)
        }
      )
      req.on('error', fail)
      req.end()
    })
    expect(status).toBe(403)
  })
})
