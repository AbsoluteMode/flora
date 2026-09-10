import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Evidence } from '../types'

// A stand-in harness whose evidence the test controls; the real adapters are
// exercised elsewhere. Kept a module-level variable so each case can set it.
let nextEvidence: Evidence = { output: '', exitCode: 0, durationMs: 1 }

vi.mock('../adapters/index', () => ({
  adapterFor: () => ({
    name: 'fake',
    execute: async () => nextEvidence
  })
}))

const { runWorkflow } = await import('../engine')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-exit-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const workflow = { name: 'exit', steps: [{ id: 'only', executor: { harness: 'command' }, run: 'x' }] }

describe('executor exit code', () => {
  it('zero passes a step with no checks', async () => {
    nextEvidence = { output: 'ok', exitCode: 0, durationMs: 1 }
    const record = await runWorkflow(workflow, { cwd: dir })
    expect(record.status).toBe('passed')
  })

  it('null is not a success: the harness never ran, or died to a signal', async () => {
    nextEvidence = { output: '[spawn error: ENOENT]', exitCode: null, durationMs: 1 }
    const record = await runWorkflow(workflow, { cwd: dir })
    expect(record.status).toBe('failed')
    expect(record.steps[0].status).toBe('failed')
  })

  it('a stalled harness fails even when every check would pass', async () => {
    nextEvidence = { output: 'partial', exitCode: 137, durationMs: 1, stalled: true }
    const record = await runWorkflow(workflow, { cwd: dir })
    expect(record.status).toBe('failed')
    expect(record.steps[0].evidence?.stalled).toBe(true)
  })
})
