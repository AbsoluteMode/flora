import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWorkflow } from '../engine'
import { loadWorkflow, resolveParams, substitute, validateWorkflow, WorkflowError } from '../workflow'
import type { WorkflowSpec } from '../types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const spec = (steps: WorkflowSpec['steps'], params?: WorkflowSpec['params']): WorkflowSpec => ({
  name: 'test',
  params,
  steps
})

describe('engine', () => {
  it('runs a step, verifies artifacts, and passes', async () => {
    const record = await runWorkflow(
      spec([
        {
          id: 'write',
          executor: { harness: 'command' },
          run: 'echo "{{msg}}" > out.txt',
          verify: [
            { type: 'artifact', path: 'out.txt', contains: '{{msg}}' },
            { type: 'command', run: 'node -e "require(\'node:fs\').accessSync(\'out.txt\')"' }
          ]
        }
      ], { msg: { default: 'ping' } }),
      { cwd: dir }
    )
    expect(record.status).toBe('passed')
    expect(record.steps[0].checks).toHaveLength(2)
    expect(record.steps[0].checks.every((c) => c.passed)).toBe(true)
  })

  it('fails the run when a check fails, and reports which one', async () => {
    const record = await runWorkflow(
      spec([
        {
          id: 'bad',
          executor: { harness: 'command' },
          run: 'echo done',
          verify: [{ type: 'artifact', path: 'missing.txt' }]
        },
        { id: 'never', executor: { harness: 'command' }, run: 'echo unreachable' }
      ]),
      { cwd: dir }
    )
    expect(record.status).toBe('failed')
    expect(record.steps).toHaveLength(1)
    expect(record.steps[0].checks[0].detail).toContain('does not exist')
  })

  it('retries per on_fail and passes on the second attempt', async () => {
    // First attempt fails the check (file absent), the step itself creates it for attempt 2.
    const record = await runWorkflow(
      spec([
        {
          id: 'flaky',
          executor: { harness: 'command' },
          run: `node -e "const fs=require('node:fs');fs.writeFileSync('marker.txt',fs.existsSync('marker.txt')?'second':'first')"`,
          verify: [{ type: 'artifact', path: 'marker.txt', contains: 'second' }],
          on_fail: { retry: 1 }
        }
      ]),
      { cwd: dir }
    )
    expect(record.status).toBe('passed')
    expect(record.steps[0].attempt).toBe(2)
  })

  it('fails when the executor exits non-zero even without checks', async () => {
    const record = await runWorkflow(
      spec([{ id: 'boom', executor: { harness: 'command' }, run: 'exit 3' }]),
      { cwd: dir }
    )
    expect(record.status).toBe('failed')
  })
})

describe('workflow spec', () => {
  it('validates and loads YAML with params', () => {
    const path = join(dir, 'wf.yaml')
    writeFileSync(
      path,
      `name: demo\nparams:\n  task: { required: true }\nsteps:\n  - id: s1\n    executor: { harness: command }\n    run: echo {{task}}\n`
    )
    const loaded = loadWorkflow(path)
    expect(loaded.name).toBe('demo')
    expect(() => resolveParams(loaded, {})).toThrow(WorkflowError)
    expect(resolveParams(loaded, { task: 'x' })).toEqual({ task: 'x' })
  })

  it('rejects unknown harnesses and duplicate ids', () => {
    expect(() =>
      validateWorkflow(spec([{ id: 'a', executor: { harness: 'nope' }, run: 'x' }]))
    ).toThrow(/unknown harness/)
    expect(() =>
      validateWorkflow(
        spec([
          { id: 'a', executor: { harness: 'command' }, run: 'x' },
          { id: 'a', executor: { harness: 'command' }, run: 'y' }
        ])
      )
    ).toThrow(/duplicate/)
  })

  it('substitute replaces only known params', () => {
    expect(substitute('run {{a}} and {{b}}', { a: '1' })).toBe('run 1 and {{b}}')
  })
})
