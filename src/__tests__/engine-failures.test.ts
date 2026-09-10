import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExecuteInput } from '../adapters/types'
import type { Evidence, RunEvent, WorkflowSpec } from '../types'

const fake = vi.hoisted(() => ({ execute: vi.fn<(input: ExecuteInput) => Promise<Evidence>>() }))
vi.mock('../adapters/index', () => ({ adapterFor: () => ({ name: 'fake', execute: fake.execute }) }))
const { runWorkflow } = await import('../engine')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flora-engine-failure-')); fake.execute.mockReset() })
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

it('validates output schemas before starting any executor', async () => {
  const spec: WorkflowSpec = { name: 'invalid', steps: [{ id: 'work', executor: { harness: 'command' }, run: 'echo side-effect', output: { type: 'json', schema: { type: 'invalid' } } }] }
  await expect(runWorkflow(spec, { cwd: dir })).rejects.toThrow(/output.schema/)
  expect(fake.execute).not.toHaveBeenCalled()
})

it.each(['dag', 'branches'] as const)('cancels and drains %s peers before propagating an exception', async (kind) => {
  const caller = new AbortController()
  const contexts: string[] = []
  const events: RunEvent[] = []
  let stopped = false
  let releasePeer: () => void = () => {}
  fake.execute.mockImplementation(async (input) => {
    contexts.push(dirname(input.env!.FLORA_CONTEXT))
    if (input.run === 'broken') throw new Error('adapter broke')
    return new Promise<Evidence>((resolve) => {
      const stop = () => { stopped = true; resolve({ output: 'aborted', exitCode: 137, durationMs: 0 }) }
      releasePeer = stop
      input.signal?.addEventListener('abort', stop, { once: true })
    })
  })
  const spec: WorkflowSpec = kind === 'dag'
    ? { name: kind, steps: [
      { id: 'slow', needs: [], executor: { harness: 'command' }, run: 'wait' },
      { id: 'broken', needs: [], executor: { harness: 'command' }, run: 'broken' }
    ] }
    : { name: kind, steps: [{ id: 'parallel', parallel: { isolation: 'shared', branches: [
      { executor: { harness: 'command' }, run: 'wait' },
      { executor: { harness: 'command' }, run: 'broken' }
    ] } }] }
  try {
    await expect(runWorkflow(spec, { cwd: dir, signal: caller.signal, onEvent: (e) => events.push(e) })).rejects.toThrow('adapter broke')
    expect(stopped).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    expect(contexts.every((path) => !existsSync(path))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'error' })
  } finally {
    caller.abort()
    releasePeer()
    for (const path of new Set(contexts)) rmSync(path, { recursive: true, force: true, maxRetries: 5 })
  }
})
