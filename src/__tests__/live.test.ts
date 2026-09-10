import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWorkflow } from '../engine'
import { createRecorder, OUTPUT_FLUSH_BYTES, OUTPUT_KEEP_BYTES } from '../recorder'
import { RunStore } from '../state'
import { startServer, type RunningServer } from '../web/server'
import type { WorkflowSpec } from '../types'

let dir: string
let dbPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-live-'))
  dbPath = join(dir, 'flora.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const spec = (steps: WorkflowSpec['steps']): WorkflowSpec => ({ name: 'live', steps })

/** Minimal SSE client: collects frames until the server closes or `until` matches. */
function readStream(
  port: number,
  path: string,
  options: { lastEventId?: number; until?: (frame: Frame) => boolean } = {}
): Promise<Frame[]> {
  return new Promise((ok, fail) => {
    const frames: Frame[] = []
    const headers: Record<string, string> = {}
    if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId)
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          if (raw.startsWith(':')) continue
          const frame = parseFrame(raw)
          frames.push(frame)
          if (options.until?.(frame)) {
            req.destroy()
            ok(frames)
            return
          }
        }
      })
      res.on('end', () => ok(frames))
      res.on('error', (err) => (err.message.includes('aborted') ? ok(frames) : fail(err)))
    })
    req.on('error', (err) => (err.message.includes('aborted') || err.message.includes('socket hang up') ? ok(frames) : fail(err)))
    req.end()
  })
}

interface Frame {
  id: number
  event: string
  data: Record<string, unknown>
}

function parseFrame(raw: string): Frame {
  const frame: Frame = { id: 0, event: 'message', data: {} }
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':')
    const field = line.slice(0, colon)
    const value = line.slice(colon + 1).trimStart()
    if (field === 'id') frame.id = Number(value)
    else if (field === 'event') frame.event = value
    else if (field === 'data') frame.data = JSON.parse(value) as Record<string, unknown>
  }
  return frame
}

describe('run_events journal', () => {
  it('appends and reads back from a cursor', () => {
    const store = new RunStore(dbPath)
    store.appendEvents('r1', [
      { at: 't1', type: 'run_start', payload: { workflow: 'x' } },
      { at: 't2', type: 'step_start', payload: { stepId: 'a' } },
      { at: 't3', type: 'step_result', payload: { stepId: 'a', status: 'passed' } }
    ])
    store.appendEvents('other', [{ at: 't1', type: 'run_start', payload: {} }])

    const all = store.readEvents('r1')
    expect(all.map((e) => e.type)).toEqual(['run_start', 'step_start', 'step_result'])
    expect(all[0].payload).toEqual({ workflow: 'x' })

    const rest = store.readEvents('r1', all[0].seq)
    expect(rest.map((e) => e.type)).toEqual(['step_start', 'step_result'])
    store.close()
  })

  it('trims only executor output, oldest first, and never reuses a seq', () => {
    const store = new RunStore(dbPath)
    const chunk = 'x'.repeat(1000)
    for (let i = 0; i < 10; i++) {
      store.appendEvents('r1', [
        { at: 't', type: 'executor_output', payload: { stepId: 'a', chunk: `${i}:${chunk}` } },
        { at: 't', type: 'check_result', payload: { stepId: 'a', passed: true, detail: `check ${i}` } }
      ])
    }
    const before = store.readEvents('r1')
    const lastSeq = before[before.length - 1].seq

    const removed = store.trimOutputEvents('r1', 3500)
    expect(removed).toBeGreaterThan(0)

    const after = store.readEvents('r1')
    const outputs = after.filter((e) => e.type === 'executor_output')
    const checks = after.filter((e) => e.type === 'check_result')
    expect(checks).toHaveLength(10) // structural events are untouchable
    expect(outputs.length).toBeLessThan(10)
    // What survived is the tail, not the head.
    expect(String(outputs[outputs.length - 1].payload.chunk).startsWith('9:')).toBe(true)
    expect(String(outputs[0].payload.chunk).startsWith('0:')).toBe(false)

    // AUTOINCREMENT: a new row must land past everything ever issued.
    store.appendEvents('r1', [{ at: 't', type: 'run_end', payload: { status: 'passed' } }])
    const tail = store.readEvents('r1', lastSeq)
    expect(tail).toHaveLength(1)
    expect(tail[0].seq).toBeGreaterThan(lastSeq)
    store.close()
  })
})

describe('recorder', () => {
  it('coalesces a chatty stream into a handful of rows without losing text', () => {
    const store = new RunStore(dbPath)
    const recorder = createRecorder(store, { cwd: dir, params: {} })
    recorder.write({ type: 'run_start', runId: 'r1', workflow: 'w', steps: 1 })
    recorder.write({ type: 'step_start', stepId: 's', attempt: 1, maxAttempts: 1, harness: 'command' })

    const chunks = 1000
    for (let i = 0; i < chunks; i++) recorder.write({ type: 'executor_output', stepId: 's', chunk: `line ${i}\n` })
    recorder.write({ type: 'step_verifying', stepId: 's', checks: 0 })
    recorder.close()

    const outputs = store.readEvents('r1').filter((e) => e.type === 'executor_output')
    const bytes = chunks * 'line 999\n'.length
    expect(outputs.length).toBeLessThanOrEqual(Math.ceil(bytes / OUTPUT_FLUSH_BYTES) + 1)
    const joined = outputs.map((e) => e.payload.chunk).join('')
    expect(joined).toContain('line 0\n')
    expect(joined).toContain(`line ${chunks - 1}\n`)
    store.close()
  })

  // 50 flushes, each a transaction plus a trim — Windows CI's disk needs more than the default 5 s.
  it('keeps the live feed bounded while the record keeps everything', { timeout: 30_000 }, () => {
    const store = new RunStore(dbPath)
    const recorder = createRecorder(store, { cwd: dir, params: {} })
    recorder.write({ type: 'run_start', runId: 'r1', workflow: 'w', steps: 1 })
    recorder.write({ type: 'step_start', stepId: 's', attempt: 1, maxAttempts: 1, harness: 'command' })
    for (let i = 0; i < 100; i++) recorder.write({ type: 'executor_output', stepId: 's', chunk: 'y'.repeat(2000) })
    recorder.close()

    const kept = store
      .readEvents('r1', 0, 10_000)
      .filter((e) => e.type === 'executor_output')
      .reduce((sum, e) => sum + String(e.payload.chunk).length, 0)
    expect(kept).toBeLessThanOrEqual(OUTPUT_KEEP_BYTES + OUTPUT_FLUSH_BYTES)
    expect(kept).toBeGreaterThan(OUTPUT_KEEP_BYTES / 2)
    store.close()
  })

  it('keeps a running record in the journal as the run progresses', () => {
    const store = new RunStore(dbPath)
    const recorder = createRecorder(store, { cwd: dir, params: { a: '1' } })
    recorder.write({ type: 'run_start', runId: 'r1', workflow: 'w', steps: 2 })
    expect(store.load('r1')).toMatchObject({ status: 'running', workflow: 'w', params: { a: '1' }, steps: [] })

    recorder.write({ type: 'step_start', stepId: 'one', title: 'First', attempt: 1, maxAttempts: 2, harness: 'command' })
    expect(store.load('r1')?.steps[0]).toMatchObject({ stepId: 'one', title: 'First', harness: 'command', status: 'running' })

    recorder.write({ type: 'step_result', stepId: 'one', status: 'failed', attempt: 1 })
    recorder.write({ type: 'step_start', stepId: 'one', title: 'First', attempt: 2, maxAttempts: 2, harness: 'command' })
    recorder.write({ type: 'step_result', stepId: 'one', status: 'passed', attempt: 2 })
    const mid = store.load('r1')
    expect(mid?.steps).toHaveLength(1) // a retry updates the step, it does not duplicate it
    expect(mid?.steps[0]).toMatchObject({ status: 'passed', attempt: 2 })

    recorder.write({ type: 'run_end', runId: 'r1', status: 'passed' })
    expect(store.load('r1')?.status).toBe('passed')
    expect(store.load('r1')?.finishedAt).toBeDefined()
    recorder.close()
    store.close()
  })
})

describe('SSE stream', () => {
  let server: RunningServer
  afterEach(async () => server?.close())

  it('replays a finished run and closes at run_end', async () => {
    const store = new RunStore(dbPath)
    const recorder = createRecorder(store, { cwd: dir, params: {} })
    const record = await runWorkflow(
      spec([{ id: 'say', executor: { harness: 'command' }, run: 'echo hello-from-the-stream' }]),
      { cwd: dir, onEvent: (e) => recorder.write(e) }
    )
    recorder.close()
    store.save(record)
    store.close()

    server = await startServer({ port: 0, dbPath })
    const frames = await readStream(server.port, `/api/runs/${record.runId}/events`)

    expect(frames.map((f) => f.event)).toEqual([
      'run_start',
      'step_start',
      'executor_output',
      'step_verifying',
      'step_result',
      'run_end'
    ])
    expect(frames.find((f) => f.event === 'executor_output')?.data.chunk).toContain('hello-from-the-stream')
    expect(frames.every((f) => f.id > 0)).toBe(true)
  })

  it('resumes from Last-Event-ID without repeating or skipping', async () => {
    const store = new RunStore(dbPath)
    const recorder = createRecorder(store, { cwd: dir, params: {} })
    const record = await runWorkflow(
      spec([
        { id: 'a', executor: { harness: 'command' }, run: 'echo a' },
        { id: 'b', executor: { harness: 'command' }, run: 'echo b' }
      ]),
      { cwd: dir, onEvent: (e) => recorder.write(e) }
    )
    recorder.close()
    store.save(record)
    store.close()

    server = await startServer({ port: 0, dbPath })
    const all = await readStream(server.port, `/api/runs/${record.runId}/events`)
    const cut = Math.floor(all.length / 2)
    const resumed = await readStream(server.port, `/api/runs/${record.runId}/events`, { lastEventId: all[cut - 1].id })

    expect(resumed.map((f) => f.id)).toEqual(all.slice(cut).map((f) => f.id))
  })

  it('follows a run while it is still happening', async () => {
    server = await startServer({ port: 0, dbPath })
    const store = new RunStore(dbPath)
    const recorder = createRecorder(store, { cwd: dir, params: {} })

    // A step slow enough that the subscriber attaches mid-run.
    const running = runWorkflow(
      spec([
        { id: 'first', executor: { harness: 'command' }, run: 'echo one' },
        { id: 'slow', executor: { harness: 'command' }, run: 'node -e "setTimeout(() => console.log(\'two\'), 700)"' }
      ]),
      { cwd: dir, onEvent: (e) => recorder.write(e) }
    )
    await new Promise((r) => setTimeout(r, 200))
    const runId = store.list()[0]?.runId
    expect(runId).toBeDefined()
    expect(store.load(runId!)?.status).toBe('running')

    const frames = await readStream(server.port, `/api/runs/${runId}/events`, { until: (f) => f.event === 'run_end' })
    const record = await running
    recorder.close()
    store.save(record)
    store.close()

    expect(frames.filter((f) => f.event === 'step_start').map((f) => f.data.stepId)).toEqual(['first', 'slow'])
    expect(frames[frames.length - 1].event).toBe('run_end')
    expect(frames[frames.length - 1].data.status).toBe('passed')
  })

  it('404s a run that does not exist', async () => {
    server = await startServer({ port: 0, dbPath })
    const response = await fetch(`${server.url}/api/runs/nope/events`)
    expect(response.status).toBe(404)
  })
})
