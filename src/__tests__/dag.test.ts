import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { schemaErrors } from '../contract'
import { runWorkflow } from '../engine'
import { evaluateWhen, truthy } from '../when'
import { validateWorkflow, WorkflowError } from '../workflow'
import type { RunEvent, StepSpec, WorkflowSpec } from '../types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-dag-'))
})
afterEach(() => {
  delete process.env.FLORA_MAX_PARALLEL
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const sleep = (id: string, ms: number, extra: Partial<StepSpec> = {}): StepSpec => ({
  id,
  executor: { harness: 'command' },
  run: `node -e "setTimeout(() => console.log('${id}'), ${ms})"`,
  ...extra
})
const wf = (steps: StepSpec[]): WorkflowSpec => ({ name: 'dag', steps })

describe('when', () => {
  it('knows the four forms and the truthy table', () => {
    expect(evaluateWhen('REVIEW_CLEAN == REVIEW_CLEAN')).toEqual({ holds: true, reason: 'REVIEW_CLEAN == REVIEW_CLEAN' })
    expect(evaluateWhen("'a' != \"a\"").holds).toBe(false)
    expect(evaluateWhen('true').holds).toBe(true)
    expect(evaluateWhen('!false').holds).toBe(true)
    expect(evaluateWhen('!yes').holds).toBe(false)
    for (const v of ['', 'false', '0', 'null', 'undefined', 'no', 'off', 'False']) expect(truthy(v), v).toBe(false)
    for (const v of ['1', 'yes', 'anything', '{{steps.x.output}}']) expect(truthy(v), v).toBe(true)
  })
})

describe('needs / when validation', () => {
  it.each([
    ['a forward reference', [sleep('a', 1, { needs: ['b'] }), sleep('b', 1)], /not a step declared above/],
    ['an unknown step', [sleep('a', 1, { needs: ['nope'] })], /not a step declared above/],
    ['itself', [sleep('a', 1, { needs: ['a'] })], /needs itself/],
    ['a repeated need', [sleep('a', 1), sleep('b', 1, { needs: ['a', 'a'] })], /twice/],
    ['an empty when', [sleep('a', 1, { when: '  ' })], /when must be/]
  ])('refuses %s', (_name, steps, message) => {
    expect(() => validateWorkflow(wf(steps))).toThrow(message)
    expect(() => validateWorkflow(wf(steps))).toThrow(WorkflowError)
  })

  it('the schema agrees on shape', () => {
    expect(schemaErrors(wf([sleep('a', 1), sleep('b', 1, { needs: ['a', 'a'] })])).length).toBeGreaterThan(0)
    expect(schemaErrors(wf([sleep('a', 1, { when: '' })])).length).toBeGreaterThan(0)
    expect(schemaErrors(wf([sleep('a', 1), sleep('b', 1, { needs: ['a'], when: '{{steps.a.output}} == a' })]))).toEqual([])
  })
})

describe('scheduler', () => {
  it('runs independent steps at the same time and joins on needs', async () => {
    const events: RunEvent[] = []
    const record = await runWorkflow(
      wf([
        sleep('root', 50),
        sleep('a', 1000, { needs: ['root'] }),
        sleep('b', 1000, { needs: ['root'] }),
        sleep('c', 1000, { needs: ['root'] }),
        {
          id: 'join',
          needs: ['a', 'b', 'c'],
          executor: { harness: 'command' },
          run: 'node -e "const c = require(process.env.FLORA_CONTEXT); console.log(Object.keys(c.steps).sort().join(\'+\'))"'
        }
      ]),
      { cwd: dir, onEvent: (e) => events.push(e) }
    )
    expect(record.status).toBe('passed')
    expect(record.steps.map((s) => s.stepId)).toEqual(['root', 'a', 'b', 'c', 'join']) // file order, not finish order
    expect(record.steps[4].evidence?.output).toBe('a+b+c+root')

    const order = events.filter((e) => e.type === 'step_start' || e.type === 'step_result').map((e) => `${e.type}:${e.stepId}`)
    const starts = ['a', 'b', 'c'].map((id) => order.indexOf(`step_start:${id}`))
    const finishes = ['a', 'b', 'c'].map((id) => order.indexOf(`step_result:${id}`))
    expect([...starts, ...finishes].every((index) => index >= 0)).toBe(true)
    // Prove concurrency and dependency order independently of process startup speed.
    expect(Math.min(...starts)).toBeGreaterThan(order.indexOf('step_result:root'))
    expect(Math.max(...starts)).toBeLessThan(Math.min(...finishes))
    expect(order.indexOf('step_start:join')).toBeGreaterThan(Math.max(...finishes))
  }, 20_000)

  it('without needs the contract stays strictly sequential', async () => {
    const events: RunEvent[] = []
    const started = Date.now()
    const record = await runWorkflow(wf([sleep('a', 600), sleep('b', 600), sleep('c', 600)]), { cwd: dir, onEvent: (e) => events.push(e) })
    expect(record.status).toBe('passed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1700)
    const starts = events.filter((e) => e.type === 'step_start').map((e) => e.stepId)
    expect(starts).toEqual(['a', 'b', 'c'])
  }, 20_000)

  it('respects FLORA_MAX_PARALLEL for steps too', async () => {
    process.env.FLORA_MAX_PARALLEL = '1'
    const started = Date.now()
    const record = await runWorkflow(wf([sleep('root', 1), sleep('a', 600, { needs: ['root'] }), sleep('b', 600, { needs: ['root'] })]), { cwd: dir })
    expect(record.status).toBe('passed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1150)
  }, 20_000)

  it('gives every step its own context snapshot', async () => {
    const record = await runWorkflow(
      wf([
        sleep('root', 1),
        {
          id: 'a',
          needs: ['root'],
          executor: { harness: 'command' },
          run: 'node -e "console.log(process.env.FLORA_CONTEXT)"'
        },
        {
          id: 'b',
          needs: ['root'],
          executor: { harness: 'command' },
          run: 'node -e "console.log(process.env.FLORA_CONTEXT)"'
        }
      ]),
      { cwd: dir }
    )
    expect(record.status).toBe('passed')
    const [a, b] = [record.steps[1].evidence?.output, record.steps[2].evidence?.output]
    expect(a).toMatch(/context-a\.json$/)
    expect(b).toMatch(/context-b\.json$/)
  }, 20_000)

  it('a failure stops new steps, lets the ones in flight finish, fails the run', async () => {
    const events: RunEvent[] = []
    const record = await runWorkflow(
      wf([
        sleep('root', 1),
        { id: 'bad', needs: ['root'], executor: { harness: 'command' }, run: 'node -e "process.exit(1)"' },
        sleep('slow', 800, { needs: ['root'] }),
        sleep('never', 1, { needs: ['bad'] }),
        sleep('also-never', 1, { needs: ['slow', 'bad'] })
      ]),
      { cwd: dir, onEvent: (e) => events.push(e) }
    )
    expect(record.status).toBe('failed')
    const ids = record.steps.map((s) => `${s.stepId}:${s.status}`)
    expect(ids).toEqual(['root:passed', 'bad:failed', 'slow:passed'])
    expect(events.filter((e) => e.type === 'step_start').map((e) => e.stepId)).not.toContain('never')
    expect(events.find((e) => e.type === 'run_end')?.failedStep).toBe('bad')
  }, 20_000)
})

describe('when at run time', () => {
  it('skips a step whose condition does not hold, and its dependants go on with its status in context', async () => {
    const events: RunEvent[] = []
    const record = await runWorkflow(
      wf([
        { id: 'review', executor: { harness: 'command' }, run: 'node -e "console.log(JSON.stringify({ verdict: \'DEFECT_FOUND\' }))"', output: { type: 'json' } },
        { id: 'ship', needs: ['review'], when: '{{steps.review.output.verdict}} == REVIEW_CLEAN', executor: { harness: 'command' }, run: 'echo shipping' },
        { id: 'fix', needs: ['review'], when: '{{steps.review.output.verdict}} != REVIEW_CLEAN', executor: { harness: 'command' }, run: 'echo fixing' },
        { id: 'report', needs: ['ship', 'fix'], executor: { harness: 'command' }, run: 'node -e "const c = require(process.env.FLORA_CONTEXT); console.log(c.steps.ship.status + \'/\' + c.steps.fix.status)"' },
        { id: 'after-skip', needs: ['ship'], when: '{{steps.ship.status}} == skipped', executor: { harness: 'command' }, run: 'echo consolation' }
      ]),
      { cwd: dir, onEvent: (e) => events.push(e) }
    )
    expect(record.status).toBe('passed')
    const byId = Object.fromEntries(record.steps.map((s) => [s.stepId, s]))
    expect(byId.ship.status).toBe('skipped')
    expect(byId.ship.skipReason).toBe('DEFECT_FOUND == REVIEW_CLEAN')
    expect(byId.ship.evidence).toBeUndefined()
    expect(byId.fix.status).toBe('passed')
    expect(byId.report.evidence?.output).toBe('skipped/passed')
    expect(byId['after-skip'].status).toBe('passed')
    expect(events.find((e) => e.type === 'step_skipped')).toMatchObject({ stepId: 'ship', when: 'DEFECT_FOUND == REVIEW_CLEAN' })
  }, 20_000)

  it('an unresolved placeholder is compared as text, which shows up in the reason', async () => {
    const record = await runWorkflow(wf([{ id: 'a', when: '{{steps.nope.output}} == x', executor: { harness: 'command' }, run: 'echo' }]), { cwd: dir })
    expect(record.status).toBe('passed')
    expect(record.steps[0].skipReason).toBe('{{steps.nope.output}} == x')
  })
})
