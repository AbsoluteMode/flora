import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunStore } from '../state'
import { isSqliteExperimentalWarning } from '../warnings'
import type { RunRecord } from '../types'

const run = promisify(execFile)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-cli-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

/** Spawn the real CLI entry, with the journal pointed at a throwaway database. */
const flora = (args: string[]) =>
  run(process.execPath, ['bin/flora.mjs', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, FLORA_DB: join(dir, 'flora.db') }
  })

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'r1',
  workflow: 'demo',
  cwd: '/tmp',
  params: {},
  status: 'passed',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:02.500Z',
  steps: [],
  ...over
})

describe('sqlite warning filter', () => {
  it('matches only the SQLite experimental warning', () => {
    const warning = (name: string, message: string): Error =>
      Object.assign(new Error(message), { name })

    expect(
      isSqliteExperimentalWarning(
        warning('ExperimentalWarning', 'SQLite is an experimental feature and might change at any time')
      )
    ).toBe(true)
    // Other experimental warnings must still reach the user.
    expect(isSqliteExperimentalWarning(warning('ExperimentalWarning', 'Type Stripping is an experimental feature'))).toBe(false)
    expect(isSqliteExperimentalWarning(warning('DeprecationWarning', 'SQLite something'))).toBe(false)
  })

  it('keeps the warning out of a real run', async () => {
    const { stderr, stdout } = await flora(['run', 'examples/hello.yaml', '--cwd', dir])
    expect(stderr).not.toContain('ExperimentalWarning')
    expect(stdout).toContain('run passed')
  })
})

describe('run journal', () => {
  it('list() carries finishedAt so callers can compute duration', () => {
    const store = new RunStore(join(dir, 'flora.db'))
    store.save(record())
    store.save(
      record({ runId: 'r2', status: 'running', startedAt: '2026-01-01T00:01:00.000Z', finishedAt: undefined })
    )
    const runs = store.list()
    store.close()

    expect(runs.map((r) => r.runId)).toEqual(['r2', 'r1'])
    expect(runs.find((r) => r.runId === 'r1')?.finishedAt).toBe('2026-01-01T00:00:02.500Z')
    expect(runs.find((r) => r.runId === 'r2')?.finishedAt).toBeUndefined()
  })
})

describe('flora runs --json', () => {
  it('prints one parseable JSON array with durations', async () => {
    await flora(['run', 'examples/hello.yaml', '--cwd', dir])
    const { stdout } = await flora(['runs', '--json'])

    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ workflow: 'hello', status: 'passed' })
    expect(typeof parsed[0].durationMs).toBe('number')
  })

  it('reports durationMs as null while a run is unfinished', () => {
    const store = new RunStore(join(dir, 'flora.db'))
    store.save(record({ status: 'running', finishedAt: undefined }))
    const [unfinished] = store.list()
    store.close()
    expect(unfinished.finishedAt).toBeUndefined()
  })
})

describe('flora open', () => {
  /** The viewer as `flora open` starts it: resolved once the address is printed, killed by the caller. */
  const open = (file: string, db: string) =>
    new Promise<{ stdout: string; url: string; stop: () => Promise<void> }>((resolve, reject) => {
      const child = spawn(process.execPath, ['bin/flora.mjs', 'open', file, '--no-browser', '--port', '0'], {
        cwd: process.cwd(),
        env: { ...process.env, FLORA_DB: db }
      })
      let stdout = ''
      const stop = () =>
        new Promise<void>((done) => {
          child.once('exit', () => done())
          child.kill()
        })
      const timer = setTimeout(() => void stop().then(() => reject(new Error(`no viewer address in:\n${stdout}`))), 20_000)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const url = /http:\/\/127\.0\.0\.1:\d+\S*/.exec(stdout)?.[0]
        if (stdout.includes('flora viewer') && url) {
          clearTimeout(timer)
          resolve({ stdout, url, stop })
        }
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`flora open exited with ${code}:\n${stdout}`))
      })
    })

  it('takes a run file into the journal, serves that run, and keeps it on the next open', async () => {
    await flora(['run', 'examples/hello.yaml', '--cwd', dir])
    const file = join(dir, 'hello.flora-run')
    await flora(['export', 'latest', '--out', file])
    // The other side: an empty journal of its own.
    const theirs = join(dir, 'theirs.db')

    const first = await open(file, theirs)
    expect(first.stdout).toContain('imported')
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/runs\/[0-9a-f-]+$/)
    const api = await fetch(first.url.replace('/runs/', '/api/runs/'))
    expect(api.status).toBe(200)
    expect((await api.json()) as Record<string, unknown>).toMatchObject({ workflow: 'hello', status: 'passed' })
    await first.stop()

    const again = await open(file, theirs)
    expect(again.stdout).toContain('already in the journal')
    expect(again.url.split('/runs/')[1]).toBe(first.url.split('/runs/')[1])
    await again.stop()
  }, 60_000)
})
