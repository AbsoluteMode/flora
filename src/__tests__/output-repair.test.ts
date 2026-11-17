import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecuteInput, RepairInput } from '../adapters/types'
import type { Evidence, RunEvent, StepSpec, WorkflowSpec } from '../types'

/**
 * A scripted agent. `execute` is the step's work, `repair` the adapter's own
 * repair route (switched off per test to exercise the fallback). Both record
 * what they were given, so a test can tell a continued session from a new run.
 */
const agent = vi.hoisted(() => ({
  execute: [] as Array<(input: ExecuteInput) => Promise<Evidence> | Evidence>,
  repair: [] as Array<(input: RepairInput) => Promise<Evidence> | Evidence>,
  executeCalls: [] as ExecuteInput[],
  repairCalls: [] as RepairInput[],
  canRepair: true
}))
vi.mock('../adapters/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/index')>()
  return {
    adapterFor: (harness: string) => {
      if (harness === 'command') return actual.adapterFor(harness)
      const execute = async (input: ExecuteInput): Promise<Evidence> => {
        agent.executeCalls.push(input)
        const next = agent.execute.shift()
        if (!next) throw new Error('unexpected execute call')
        return next(input)
      }
      const repair = async (input: RepairInput): Promise<Evidence> => {
        agent.repairCalls.push(input)
        const next = agent.repair.shift()
        if (!next) throw new Error('unexpected repair call')
        return next(input)
      }
      return agent.canRepair ? { name: harness, execute, repair } : { name: harness, execute }
    }
  }
})
const { runWorkflow, outputRepairSettings } = await import('../engine')
const { validateWorkflow, WorkflowError } = await import('../workflow')
const { schemaErrors } = await import('../contract')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-repair-'))
  agent.execute.length = 0
  agent.repair.length = 0
  agent.executeCalls.length = 0
  agent.repairCalls.length = 0
  agent.canRepair = true
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))

/** The live case of 15.11.2026: `changes` and `checks` declared as strings, Codex answered with lists. */
const SCHEMA = {
  type: 'object',
  required: ['summary', 'changes', 'checks'],
  properties: { summary: { type: 'string' }, changes: { type: 'string' }, checks: { type: 'string' } }
}
const LISTS = '```json\n{"summary":"done","changes":["a.ts","b.ts"],"checks":["npm test"]}\n```'
const STRINGS = '```json\n{"summary":"done","changes":"a.ts, b.ts","checks":"npm test"}\n```'

const answer = (output: string, extra: Partial<Evidence> = {}): (() => Evidence) => () => ({ output, exitCode: 0, durationMs: 1000, ...extra })

function step(extra: Partial<StepSpec> = {}): StepSpec {
  return { id: 'build', executor: { harness: 'codex' }, prompt: 'Do the work', output: { type: 'json', schema: SCHEMA }, ...extra }
}

async function run(spec: WorkflowSpec, signal?: AbortSignal, onEvent?: (e: RunEvent) => void) {
  const events: RunEvent[] = []
  const record = await runWorkflow(spec, { cwd: dir, signal, onEvent: (e) => { events.push(e); onEvent?.(e) } })
  return { record, events, repairEvents: events.filter((e) => e.type.startsWith('output_repair')) }
}

describe('output repair in the same session', () => {
  it('the live case: lists instead of strings → one repair in the same session → the step passes, the work is not rerun', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 'thread-1', costUsd: 0.5, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } }))
    agent.repair.push(answer(STRINGS, { sessionId: 'thread-1', durationMs: 300, costUsd: 0.02, usage: { inputTokens: 1100, outputTokens: 30, totalTokens: 1130 } }))

    const { record, events, repairEvents } = await run({ name: 'live', steps: [step()] })

    expect(record.status).toBe('passed')
    const result = record.steps[0]
    expect(result.attempt).toBe(1)
    expect(result.output).toEqual({ summary: 'done', changes: 'a.ts, b.ts', checks: 'npm test' })
    expect(result.outputError).toBeUndefined()
    // The work ran once; the second call was a continuation of its session.
    expect(agent.executeCalls).toHaveLength(1)
    expect(agent.repairCalls).toHaveLength(1)
    expect(agent.repairCalls[0].sessionId).toBe('thread-1')
    expect(agent.repairCalls[0].spec.harness).toBe('codex')

    // The journal: start and result, with the attempt number, the validation errors and the duration.
    expect(repairEvents).toEqual([
      expect.objectContaining({
        type: 'output_repair_start', stepId: 'build', attempt: 1, repair: 1, maxRepairs: 2, mode: 'resume', sessionId: 'thread-1',
        error: 'output does not match the schema: /changes must be string; /checks must be string',
        errors: [{ path: '/changes', message: 'must be string' }, { path: '/checks', message: 'must be string' }]
      }),
      expect.objectContaining({ type: 'output_repair_result', stepId: 'build', attempt: 1, repair: 1, mode: 'resume', status: 'passed', durationMs: 300, exitCode: 0, costUsd: 0.02 })
    ])
    // Repair happens before the checks and the verdict.
    const order = events.map((e) => e.type)
    expect(order.indexOf('output_repair_result')).toBeLessThan(order.indexOf('step_verifying'))
    expect(order.indexOf('output_repair_result')).toBeLessThan(order.indexOf('step_result'))

    // On the record: the request, and what it spent added to the step's evidence.
    expect(result.outputRepairs).toEqual([
      expect.objectContaining({ repair: 1, mode: 'resume', status: 'passed', durationMs: 300, exitCode: 0, costUsd: 0.02, sessionId: 'thread-1', output: STRINGS })
    ])
    expect(result.evidence).toMatchObject({ output: LISTS, durationMs: 1300, costUsd: 0.52, sessionId: 'thread-1' })
    expect(result.evidence?.usage).toEqual({ inputTokens: 2100, outputTokens: 230, totalTokens: 2330 })
  })

  it('tells the agent what is wrong (paths and reasons), shows the schema and asks for the form only', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 'thread-1' }))
    agent.repair.push(answer(STRINGS))
    await run({ name: 'message', steps: [step()] })

    const message = agent.repairCalls[0].prompt!
    expect(message).toContain('- /changes: must be string')
    expect(message).toContain('- /checks: must be string')
    expect(message).toContain(JSON.stringify(SCHEMA, null, 2))
    expect(message).toContain('Do not redo the work, do not change files and do not run commands; return the same result in the required form.')
    expect(message).toContain('exactly one ```json code block')
    // The agent has its own answer in the session: it is not quoted back.
    expect(message).not.toContain('a.ts')
    // The step's prompt carried the schema from the start, too.
    expect(agent.executeCalls[0].prompt).toBe('Do the work')
    expect(agent.executeCalls[0].output?.schema).toEqual(SCHEMA)
  })

  it('two failed repairs: the step fails, the error names the attempts and the last reason', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 'thread-1' }))
    agent.repair.push(
      answer('```json\n{"summary":"done","changes":"a.ts","checks":["npm test"]}\n```'),
      answer('Sorry, here:\n```json\n{"summary": 1\n```')
    )
    const { record, repairEvents } = await run({ name: 'exhausted', steps: [step()] })

    expect(record.status).toBe('failed')
    const result = record.steps[0]
    expect(agent.executeCalls).toHaveLength(1)
    expect(agent.repairCalls.map((c) => c.sessionId)).toEqual(['thread-1', 'thread-1'])
    // The second request is about what was still wrong after the first.
    expect(agent.repairCalls[1].prompt).toContain('- /checks: must be string')
    expect(agent.repairCalls[1].prompt).not.toContain('/changes')
    expect(result.outputError).toMatch(/^output is not valid JSON: .* \(output repair: 2 requests did not fix it\)$/)
    expect(result.outputRepairs?.map((r) => r.status)).toEqual(['failed', 'failed'])
    expect(result.outputRepairs?.[1].resultError).toMatch(/not valid JSON/)
    expect(repairEvents.filter((e) => e.type === 'output_repair_result').map((e) => e.status)).toEqual(['failed', 'failed'])
    const failed = repairEvents.find((e) => e.type === 'output_repair_result' && e.repair === 1)!
    expect(failed.errors).toEqual([{ path: '/checks', message: 'must be string' }])
  })

  it('attempts: 0 is the old behaviour — the broken contract fails the step at once', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 'thread-1' }))
    const { record, repairEvents } = await run({ name: 'off', steps: [step({ output_repair: { attempts: 0 } })] })
    expect(record.status).toBe('failed')
    expect(record.steps[0].outputError).toBe('output does not match the schema: /changes must be string; /checks must be string')
    expect(record.steps[0].outputRepairs).toBeUndefined()
    expect(agent.repairCalls).toHaveLength(0)
    expect(repairEvents).toHaveLength(0)
  })

  it('the workflow sets the default, a step overrides it', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 't' }), answer(LISTS, { sessionId: 't' }))
    agent.repair.push(answer(LISTS), answer(LISTS), answer(LISTS))
    const { record } = await run({
      name: 'defaults',
      output_repair: { attempts: 1 },
      steps: [step({ id: 'a', needs: [] }), step({ id: 'b', needs: [], output_repair: { attempts: 2 } })]
    })
    expect(record.steps.find((s) => s.stepId === 'a')?.outputRepairs).toHaveLength(1)
    expect(record.steps.find((s) => s.stepId === 'b')?.outputRepairs).toHaveLength(2)
    expect(record.steps.find((s) => s.stepId === 'a')?.outputError).toContain('(output repair: 1 request did not fix it)')
  })

  it.each([
    ['prose without JSON', 'All done, I changed a.ts and b.ts.', 'no JSON block found'],
    ['broken JSON', '```json\n{"summary": "done",\n```', 'not valid JSON'],
    ['an empty answer', '', 'the output is empty']
  ])('%s is repaired too', async (_name, output, reason) => {
    agent.execute.push(answer(output, { sessionId: 's-1' }))
    agent.repair.push(answer(STRINGS))
    const { record, repairEvents } = await run({ name: 'not-json', steps: [step()] })
    expect(record.status).toBe('passed')
    expect(repairEvents[0]).toMatchObject({ type: 'output_repair_start', mode: 'resume', error: expect.stringContaining(reason) })
    expect(agent.repairCalls[0].prompt).toContain(reason)
  })

  it('an answer over the size limit is not a form problem: no repair', async () => {
    agent.execute.push(answer('```json\n' + JSON.stringify({ blob: 'x'.repeat(300 * 1024) }) + '\n```', { sessionId: 's' }))
    const { record } = await run({ name: 'big', steps: [step({ output: { type: 'json' } })] })
    expect(record.status).toBe('failed')
    expect(record.steps[0].outputError).toMatch(/exceeds 256KB/)
    expect(agent.repairCalls).toHaveLength(0)
  })

  it('a failed executor is not repaired — there is no finished work to reshape', async () => {
    agent.execute.push(() => ({ output: 'crashed', exitCode: 1, durationMs: 5, sessionId: 's' }))
    const { record } = await run({ name: 'crash', steps: [step()] })
    expect(record.status).toBe('failed')
    expect(agent.repairCalls).toHaveLength(0)
  })

  it('a command step is never asked: its broken output fails the step as before', async () => {
    const { record, repairEvents } = await run({
      name: 'cmd',
      output_repair: { attempts: 2 },
      steps: [{ id: 'c', executor: { harness: 'command' }, run: 'echo not-json', output: { type: 'json' } }]
    })
    expect(record.status).toBe('failed')
    expect(record.steps[0].outputError).toContain('not valid JSON')
    expect(repairEvents).toHaveLength(0)
  })

  it('repairs a parallel branch and says which branch in the journal', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 'b0' }))
    agent.repair.push(answer(STRINGS))
    const { record, repairEvents } = await run({
      name: 'fan',
      steps: [{
        id: 'fan',
        output_repair: { attempts: 1 },
        parallel: { isolation: 'shared', branches: [{ executor: { harness: 'claude-code' }, prompt: 'go', output: { type: 'json', schema: SCHEMA } }] }
      }]
    })
    expect(record.status).toBe('passed')
    expect(repairEvents.map((e) => [e.type, e.stepId, e.branch])).toEqual([
      ['output_repair_start', 'fan[0]', 0],
      ['output_repair_result', 'fan[0]', 0]
    ])
    expect(record.steps[0].branches?.[0].outputRepairs).toHaveLength(1)
    expect(agent.repairCalls[0].sessionId).toBe('b0')
  })

  it('when repairs run out, on_fail.retry still reruns the step with the contract feedback', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 't1', costUsd: 1 }), answer(STRINGS, { sessionId: 't2' }))
    agent.repair.push(answer(LISTS, { costUsd: 0.1 }))
    const { record } = await run({ name: 'retry', steps: [step({ output_repair: { attempts: 1 }, on_fail: { retry: 1 } })] })
    expect(record.status).toBe('passed')
    expect(record.steps[0].attempt).toBe(2)
    expect(agent.executeCalls[1].prompt).toMatch(/Previous attempt failed the output contract: .*output repair: 1 request did not fix it/)
    // The first attempt's money includes its repair.
    expect(record.steps[0].priorAttempts?.[0].evidence?.costUsd).toBeCloseTo(1.1)
  })
})

describe('when the session cannot be continued', () => {
  it('an adapter without a repair route: one fresh request through execute, the answer quoted, no tools', async () => {
    agent.canRepair = false
    agent.execute.push(answer(LISTS, { sessionId: 'ignored' }), answer(STRINGS))
    const { record, repairEvents } = await run({
      name: 'fallback',
      steps: [step({ executor: { harness: 'harmonia' }, output_repair: { attempts: 2 } })]
    })
    expect(record.status).toBe('passed')
    expect(agent.executeCalls).toHaveLength(2)
    const fresh = agent.executeCalls[1]
    expect(fresh.prompt).toContain('You are only converting the form of that answer.')
    expect(fresh.prompt).toContain('<<<\n' + LISTS + '\n>>>')
    expect(fresh.prompt).toContain('- /changes: must be string')
    expect(fresh.prompt).toContain('"changes": {')
    // No output instruction appended twice, no MCP servers mounted.
    expect(fresh.output).toBeUndefined()
    expect(fresh.mcp).toBeUndefined()
    expect(repairEvents[0]).toMatchObject({ mode: 'fresh', maxRepairs: 1 })
    expect(repairEvents[0]).not.toHaveProperty('sessionId')
  })

  it('a fresh request is tried once only, whatever the attempts', async () => {
    agent.canRepair = false
    agent.execute.push(answer(LISTS), answer(LISTS))
    const { record } = await run({ name: 'fallback-once', steps: [step({ executor: { harness: 'api', provider: 'x' }, output_repair: { attempts: 3 } })] })
    expect(record.status).toBe('failed')
    expect(agent.executeCalls).toHaveLength(2)
    expect(record.steps[0].outputError).toContain('(output repair: 1 request did not fix it)')
  })

  it('a resumable adapter whose session id is unknown: a fresh read-only repair request', async () => {
    agent.execute.push(answer(LISTS))
    agent.repair.push(answer(STRINGS))
    const { record, repairEvents } = await run({ name: 'no-session', steps: [step()] })
    expect(record.status).toBe('passed')
    expect(agent.repairCalls[0].sessionId).toBeUndefined()
    expect(agent.repairCalls[0].prompt).toContain('<<<\n' + LISTS + '\n>>>')
    expect(repairEvents[0]).toMatchObject({ mode: 'fresh' })
  })

  it('a long answer is quoted by its tail, where the block is', async () => {
    const long = 'x'.repeat(40 * 1024) + '\n' + LISTS
    agent.execute.push(answer(long))
    agent.repair.push(answer(STRINGS))
    await run({ name: 'long', steps: [step()] })
    const message = agent.repairCalls[0].prompt!
    expect(message).toContain('bytes earlier omitted]')
    expect(message).toContain(LISTS)
    expect(message.length).toBeLessThan(36 * 1024)
  })

  it('a session that cannot be resumed falls back to one fresh request', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 'gone' }))
    agent.repair.push(() => ({ output: 'session gone not found', exitCode: 1, durationMs: 10 }), answer(STRINGS))
    const { record } = await run({ name: 'resume-failed', steps: [step({ output_repair: { attempts: 3 } })] })
    expect(record.status).toBe('passed')
    expect(agent.repairCalls.map((c) => c.sessionId)).toEqual(['gone', undefined])
    expect(record.steps[0].outputRepairs?.map((r) => [r.mode, r.status])).toEqual([['resume', 'failed'], ['fresh', 'passed']])
    expect(record.steps[0].outputRepairs?.[0].resultError).toBe('exit 1: session gone not found')
  })
})

describe('time limits and cancellation', () => {
  it('a repair request gets its own short limit, never longer than the step\'s', () => {
    expect(outputRepairSettings(undefined, { harness: 'codex' })).toEqual({ attempts: 2, timeoutMin: 5 })
    expect(outputRepairSettings({ timeout_min: 10 }, { harness: 'codex', timeout_min: 3 })).toEqual({ attempts: 2, timeoutMin: 3 })
    expect(outputRepairSettings({ attempts: 4, timeout_min: 1 }, { harness: 'codex', timeout_min: 0 })).toEqual({ attempts: 4, timeoutMin: 1 })
    expect(outputRepairSettings({ timeout_min: 0 }, { harness: 'codex', timeout_min: 20 })).toEqual({ attempts: 2, timeoutMin: 20 })
    expect(outputRepairSettings({ timeout_min: 0 }, { harness: 'codex', timeout_min: 0 })).toEqual({ attempts: 2, timeoutMin: 0 })
  })

  it('a repair that times out stops the repairs and says so', async () => {
    agent.execute.push(answer(LISTS, { sessionId: 's' }))
    agent.repair.push(() => ({ output: '[flora: killed at the 2 min wall-clock limit]', exitCode: 137, durationMs: 120_000, timedOut: true }))
    const { record } = await run({
      name: 'slow',
      steps: [step({ executor: { harness: 'codex', timeout_min: 30, stall_min: 4 }, output_repair: { attempts: 2, timeout_min: 2 } })]
    })
    // The adapter got the repair's own limit, the step's stall limit kept.
    expect(agent.repairCalls[0].spec).toMatchObject({ timeout_min: 2, stall_min: 4 })
    expect(agent.repairCalls).toHaveLength(1)
    expect(record.status).toBe('failed')
    expect(record.steps[0].outputError).toBe(
      'output does not match the schema: /changes must be string; /checks must be string (output repair: 1 request did not fix it; the last one failed: timed out)'
    )
    expect(record.steps[0].outputRepairs?.[0]).toMatchObject({ timedOut: true, exitCode: 137, resultError: 'timed out' })
  })

  it('cancelling the run during a repair stops it and ends the run as an error', async () => {
    const caller = new AbortController()
    agent.execute.push(answer(LISTS, { sessionId: 's' }))
    let sawAbort = false
    agent.repair.push((input) => new Promise<Evidence>((resolve) => {
      input.signal?.addEventListener('abort', () => { sawAbort = true; resolve({ output: '[flora: aborted]', exitCode: 137, durationMs: 5 }) }, { once: true })
    }))
    const { record, repairEvents } = await run(
      { name: 'cancel', steps: [step({ output_repair: { attempts: 2 } })] },
      caller.signal,
      (e) => { if (e.type === 'output_repair_start') setTimeout(() => caller.abort(), 10) }
    )
    expect(sawAbort).toBe(true)
    expect(agent.repairCalls).toHaveLength(1)
    expect(record.status).toBe('error')
    expect(repairEvents.at(-1)).toMatchObject({ type: 'output_repair_result', status: 'failed', error: 'aborted' })
  })
})

describe('the output_repair setting', () => {
  const base = (extra: Record<string, unknown>, root: Record<string, unknown> = {}): WorkflowSpec =>
    ({ name: 'w', ...root, steps: [{ id: 's', executor: { harness: 'codex' }, prompt: 'p', output: { type: 'json' }, ...extra }] }) as WorkflowSpec

  it('accepts attempts and timeout_min at the root, on a step, on a parallel step and on a branch', () => {
    const ok: WorkflowSpec[] = [
      base({}, { output_repair: { attempts: 0 } }),
      base({ output_repair: { attempts: 3, timeout_min: 1.5 } }),
      {
        name: 'w',
        steps: [{
          id: 'p',
          output_repair: { attempts: 1 },
          parallel: { branches: [{ executor: { harness: 'claude-code' }, prompt: 'p', output: { type: 'json' }, output_repair: { attempts: 2 } }] }
        }]
      }
    ]
    for (const spec of ok) {
      expect(() => validateWorkflow(spec)).not.toThrow()
      expect(schemaErrors(spec)).toEqual([])
    }
  })

  it.each([
    ['a negative count', base({ output_repair: { attempts: -1 } }), /attempts must be an integer >= 0/],
    ['a fractional count', base({}, { output_repair: { attempts: 1.5 } }), /attempts must be an integer >= 0/],
    ['an unknown field', base({ output_repair: { tries: 2 } }), /unknown field "tries"/],
    ['a negative timeout', base({ output_repair: { timeout_min: -1 } }), /timeout_min must be a number/],
    ['not a mapping', base({ output_repair: 2 }), /output_repair must be a mapping/],
    ['a command step', { name: 'w', steps: [{ id: 's', executor: { harness: 'command' }, run: 'x', output: { type: 'json' }, output_repair: { attempts: 1 } }] } as WorkflowSpec, /only applies to agent harnesses/],
    ['a step without a json contract', { name: 'w', steps: [{ id: 's', executor: { harness: 'codex' }, prompt: 'p', output_repair: { attempts: 1 } }] } as WorkflowSpec, /needs output.type: json/]
  ])('refuses %s, in code and in the published schema alike', (_name, spec, message) => {
    expect(() => validateWorkflow(spec)).toThrow(WorkflowError)
    expect(() => validateWorkflow(spec)).toThrow(message)
    expect(schemaErrors(spec).length).toBeGreaterThan(0)
  })
})
