import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runWorkflow } from '../engine'
import { createRecorder } from '../recorder'
import { RunStore } from '../state'
import { Watcher } from '../watch'
import * as triggers from '../triggers'
import { startServer } from '../web/server'
import type { RunRecord } from '../types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flora-lifecycle-')); vi.stubEnv('FLORA_HOME', dir) })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })

const record = (): RunRecord => ({ runId: 'r', workflow: 'audit', cwd: dir, params: {}, status: 'passed', startedAt: new Date().toISOString(), steps: [] })

it('publishes the full verified record before announcing a finished run', async () => {
  const store = new RunStore(join(dir, 'flora.db'))
  const recorder = createRecorder(store, { cwd: dir, params: {} })
  writeFileSync(join(dir, 'proof.txt'), 'hello')
  try {
    await runWorkflow({ name: 'audit', steps: [{ id: 's', executor: { harness: 'command' }, run: 'echo hello', verify: [{ type: 'artifact', path: 'proof.txt' }] }] }, {
      cwd: dir, onEvent: (event) => {
        recorder.write(event)
        if (event.type === 'run_end') {
          const saved = store.load(String(event.runId))!
          expect(saved.status).toBe('passed')
          expect(saved.steps[0].checks[0]?.passed).toBe(true)
          expect(saved.steps[0].evidence?.exitCode).toBe(0)
        }
      }
    })
  } finally { recorder.close(); store.close() }
})

it('waits for a pending poll and never starts its work after stop', async () => {
  writeFileSync(join(dir, 'poll.yaml'), 'name: poll\non:\n  sentry: { org: o, project: p }\nsteps:\n  - id: a\n    executor: { harness: command }\n    run: echo hi\n')
  let release!: (events: triggers.TriggerEvent[]) => void
  vi.spyOn(triggers, 'pollSentry').mockImplementation(() => new Promise((resolve) => { release = resolve }))
  const runner = vi.fn(async () => record())
  const store = new RunStore(join(dir, 'flora.db'))
  const watcher = new Watcher({ paths: [dir], cwd: dir, store, log: () => {}, runner })
  watcher.start()
  let stopped = false
  const stopping = watcher.stop().then(() => { stopped = true })
  try {
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
    release([{ source: 'sentry', id: 'late', at: new Date().toISOString() }])
    await stopping
    expect(runner).not.toHaveBeenCalled()
    await watcher.stop()
  } finally { release([]); await stopping; await Promise.resolve(); store.close() }
})

it('refuses directory links in static and declared artifact paths', async () => {
  const web = join(dir, 'web'), secret = join(dir, 'private')
  mkdirSync(web); mkdirSync(secret)
  writeFileSync(join(secret, 'secret.txt'), 'private data')
  symlinkSync(secret, join(web, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const artifacts = join(dir, 'runs', 'r', 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  symlinkSync(secret, join(artifacts, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const store = new RunStore(join(dir, 'flora.db'))
  store.save({ ...record(), steps: [{ stepId: 's', attempt: 1, status: 'passed', checks: [], artifacts: [{ path: 'linked/secret.txt', source: 'proof.txt', bytes: 12 }] }] })
  store.close()
  const server = await startServer({ port: 0, dbPath: join(dir, 'flora.db'), webRoot: web })
  try {
    expect((await fetch(`${server.url}/linked/secret.txt`)).status).toBe(404)
    expect((await fetch(`${server.url}/api/runs/r/artifacts/linked/secret.txt`)).status).toBe(404)
  } finally { await server.close() }
})

it('rejects invalid HTTP journal limits before querying SQLite', async () => {
  const server = await startServer({ port: 0, dbPath: join(dir, 'flora.db') })
  try {
    for (const value of ['-1', '1.5', 'NaN', '1001', '0']) {
      expect((await fetch(`${server.url}/api/runs?limit=${value}`)).status, value).toBe(400)
    }
  } finally { await server.close() }
})
