import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContext, lookup, parsePath, substituteContext } from '../context'
import { OUTPUT_INSTRUCTION, OUTPUT_LIMIT_BYTES, readOutput, withOutputInstruction } from '../output'
import { loadWorkflow, validateWorkflow, WorkflowError } from '../workflow'
import type { Evidence, WorkflowSpec } from '../types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-data-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const spec = (steps: WorkflowSpec['steps'], params?: WorkflowSpec['params']): WorkflowSpec => ({
  name: 'data',
  params,
  steps
})

// A scripted harness for the agent-side behaviour (prompt instruction, retry
// feedback, JSON extraction from prose). Each call shifts the next reply.
const replies: Evidence[] = []
const prompts: Array<string | undefined> = []
vi.mock('../adapters/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/index')>()
  return {
    adapterFor: (harness: string) =>
      harness === 'command'
        ? actual.adapterFor(harness)
        : {
            name: harness,
            execute: async (input: { prompt?: string }) => {
              prompts.push(input.prompt)
              return replies.shift() ?? { output: '', exitCode: 0, durationMs: 1 }
            }
          }
  }
})
const { runWorkflow } = await import('../engine')

describe('path resolver', () => {
  it('parses dots and indices, nothing else', () => {
    expect(parsePath('steps.fetch.output.items[0].id')).toEqual(['steps', 'fetch', 'output', 'items', '0', 'id'])
    expect(parsePath('a[1][2]')).toEqual(['a', '1', '2'])
    expect(parsePath('a.b-c')).toEqual(['a', 'b-c'])
    expect(parsePath('a..b')).toBeNull()
    expect(parsePath('a[x]')).toBeNull()
    expect(parsePath('a.b()')).toBeNull()
    expect(parsePath('')).toBeNull()
  })

  it('looks values up, with a bare name meaning params', () => {
    const context = buildContext({ task: 'fix it' }, [
      { stepId: 'fetch', attempt: 1, status: 'passed', checks: [], output: { items: [{ id: 7 }, { id: 8 }], n: 2 } },
      { stepId: 'plain', attempt: 1, status: 'passed', checks: [], evidence: { output: 'just text', exitCode: 0, durationMs: 1 } }
    ])
    expect(lookup(context, 'task')).toBe('fix it')
    expect(lookup(context, 'params.task')).toBe('fix it')
    expect(lookup(context, 'steps.fetch.output.items[1].id')).toBe(8)
    expect(lookup(context, 'steps.fetch.output.items.length')).toBe(2)
    expect(lookup(context, 'steps.plain.output')).toBe('just text')
    expect(lookup(context, 'steps.nope.output')).toBeUndefined()
    expect(lookup(context, 'steps.fetch.output.items[5].id')).toBeUndefined()
  })

  it('substitutes what resolves, inlines objects as JSON, leaves the rest alone', () => {
    const context = buildContext({ task: 'x' }, [
      { stepId: 'fetch', attempt: 1, status: 'passed', checks: [], output: { items: [1, 2], ok: true, none: null } }
    ])
    expect(substituteContext('do {{task}} with {{steps.fetch.output.items}}', context)).toBe('do x with [1,2]')
    expect(substituteContext('{{ steps.fetch.output }}', context)).toBe('{"items":[1,2],"ok":true,"none":null}')
    expect(substituteContext('{{steps.fetch.output.ok}} / {{steps.fetch.output.none}}', context)).toBe('true / null')
    expect(substituteContext('{{missing}} and {{steps.fetch.output.nope}}', context)).toBe('{{missing}} and {{steps.fetch.output.nope}}')
  })
})

describe('output contract', () => {
  it("parses a command step's whole output as JSON", () => {
    expect(readOutput('{"a":1}\n', { type: 'json' }, 'command')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('takes the last fenced JSON block out of an agent transcript', () => {
    const transcript = 'Thinking…\n```json\n{"draft": true}\n```\nActually:\n```json\n{"items": [1]}\n```\nDone.'
    expect(readOutput(transcript, { type: 'json' }, 'claude-code')).toEqual({ ok: true, value: { items: [1] } })
  })

  it("survives stderr noise mixed into a command's output", () => {
    expect(readOutput('(node:1) ExperimentalWarning: something\n{"a":1}', { type: 'json' }, 'command')).toEqual({
      ok: true,
      value: { a: 1 }
    })
  })

  it('rejects invalid JSON, a missing block, and a schema mismatch — each with a clear reason', () => {
    expect(readOutput('not json', { type: 'json' }, 'command')).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') })
    expect(readOutput('no fences here', { type: 'json' }, 'claude-code')).toMatchObject({ ok: false, error: expect.stringContaining('no JSON block') })
    const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array' } } }
    expect(readOutput('{"items": "nope"}', { type: 'json', schema }, 'command')).toMatchObject({
      ok: false,
      error: expect.stringContaining('/items must be array')
    })
    expect(readOutput('{}', { type: 'json', schema }, 'command')).toMatchObject({ ok: false, error: expect.stringContaining("required property 'items'") })
  })

  it('refuses anything over the size limit, for json and declared text alike', () => {
    const big = JSON.stringify({ blob: 'x'.repeat(OUTPUT_LIMIT_BYTES) })
    expect(readOutput(big, { type: 'json' }, 'command')).toMatchObject({ ok: false, error: expect.stringContaining('exceeds 256KB') })
    expect(readOutput(big, { type: 'text' }, 'command')).toMatchObject({ ok: false, error: expect.stringContaining('exceeds 256KB') })
    // No contract, no limit: the text is evidence, not a value.
    expect(readOutput(big, undefined, 'command')).toEqual({ ok: true, value: undefined })
  })

  it('asks an agent for a json block only when the contract wants json', () => {
    expect(withOutputInstruction('do the thing', { type: 'json' })).toBe(`do the thing\n\n${OUTPUT_INSTRUCTION}`)
    expect(withOutputInstruction('do the thing', { type: 'text' })).toBe('do the thing')
    expect(withOutputInstruction('do the thing', undefined)).toBe('do the thing')
  })
})

describe('workflow validation', () => {
  it('refuses step outputs inside shell lines, for steps and for checks', () => {
    expect(() =>
      validateWorkflow(spec([{ id: 'a', executor: { harness: 'command' }, run: 'echo {{steps.x.output}}' }]))
    ).toThrow(/not allowed in "run".*FLORA_CONTEXT/)
    expect(() =>
      validateWorkflow(
        spec([{ id: 'a', executor: { harness: 'command' }, run: 'true', verify: [{ type: 'command', run: 'test {{ steps.x.output }}' }] }])
      )
    ).toThrow(WorkflowError)
    // Params stay welcome in run, and step outputs in prompts and expectations.
    expect(() =>
      validateWorkflow(
        spec([
          { id: 'a', executor: { harness: 'command' }, run: 'echo {{params.task}} {{task}}', output: { type: 'json' } },
          {
            id: 'b',
            executor: { harness: 'claude-code' },
            prompt: 'use {{steps.a.output}}',
            verify: [{ type: 'command', run: 'echo', expect_match: '{{steps.a.output.x}}' }]
          }
        ])
      )
    ).not.toThrow()
  })

  it('checks the output contract itself', () => {
    expect(() => validateWorkflow(spec([{ id: 'a', executor: { harness: 'command' }, run: 'x', output: { type: 'xml' as 'json' } }]))).toThrow(/json or text/)
    expect(() => validateWorkflow(spec([{ id: 'a', executor: { harness: 'command' }, run: 'x', output: { schema: { type: 'object' } } }]))).toThrow(/needs output.type: json/)
  })
})

describe('engine data flow', () => {
  it('journals a json output and hands it to the next step through $FLORA_CONTEXT and {{steps}}', async () => {
    const record = await runWorkflow(
      spec([
        {
          id: 'fetch',
          executor: { harness: 'command' },
          run: 'node -e "console.log(JSON.stringify({ items: [{ id: 41 }, { id: 42 }] }))"',
          output: { type: 'json', schema: { type: 'object', required: ['items'] } }
        },
        {
          id: 'use',
          executor: { harness: 'command' },
          // The shell step reads the context file; nothing is interpolated.
          run: 'node -e "const c = require(process.env.FLORA_CONTEXT); console.log(c.steps.fetch.output.items[1].id + \'!\')"',
          // Both sides are derived independently: the shell reads the context
          // file, the expectation is substituted from the same data.
          verify: [
            {
              type: 'command',
              run: 'node -e "const c = require(process.env.FLORA_CONTEXT); console.log(c.steps.fetch.output.items.length + \'-\' + c.params.who)"',
              expect_match: '{{steps.fetch.output.items.length}}-{{who}}'
            }
          ]
        }
      ], { who: { default: '2-me' } }),
      { cwd: dir, params: { who: '2-me' } }
    )
    expect(record.status).toBe('passed')
    expect(record.steps[0].output).toEqual({ items: [{ id: 41 }, { id: 42 }] })
    expect(record.steps[1].evidence?.output).toBe('42!')
    expect(record.steps[1].output).toBeUndefined() // no contract declared
  })

  it('fails the step when the output breaks the contract, and records why', async () => {
    const record = await runWorkflow(
      spec([{ id: 'bad', executor: { harness: 'command' }, run: 'echo not-json', output: { type: 'json' } }]),
      { cwd: dir }
    )
    expect(record.status).toBe('failed')
    expect(record.steps[0].outputError).toContain('not valid JSON')
    expect(record.steps[0].output).toBeUndefined()
  })

  it('fails on the size limit with a clear error', async () => {
    const record = await runWorkflow(
      spec([
        {
          id: 'huge',
          executor: { harness: 'command' },
          run: `node -e "process.stdout.write(JSON.stringify({ blob: 'x'.repeat(${OUTPUT_LIMIT_BYTES}) }))"`,
          output: { type: 'json' }
        }
      ]),
      { cwd: dir }
    )
    expect(record.status).toBe('failed')
    expect(record.steps[0].outputError).toMatch(/exceeds 256KB \(\d+ bytes\)/)
  })

  it('retries an agent with feedback about the broken contract, then takes the last json block', async () => {
    prompts.length = 0
    replies.push(
      { output: 'Here you go: {not json', exitCode: 0, durationMs: 1 },
      { output: 'Second try.\n```json\n{"answer": 42}\n```', exitCode: 0, durationMs: 1 }
    )
    const record = await runWorkflow(
      spec([
        {
          id: 'ask',
          executor: { harness: 'claude-code' },
          prompt: 'Answer with {{task}}',
          output: { type: 'json', schema: { type: 'object', required: ['answer'] } },
          on_fail: { retry: 1 }
        }
      ], { task: { default: 'a number' } }),
      { cwd: dir }
    )
    expect(record.status).toBe('passed')
    expect(record.steps[0].attempt).toBe(2)
    expect(record.steps[0].output).toEqual({ answer: 42 })
    expect(prompts[0]).toBe('Answer with a number')
    expect(prompts[1]).toContain('Answer with a number')
    expect(prompts[1]).toMatch(/Previous attempt failed the output contract: .*JSON.*Return valid output\./)
  })

  it('does not add feedback when the failure was not the contract', async () => {
    prompts.length = 0
    replies.push({ output: 'boom', exitCode: 1, durationMs: 1 }, { output: '```json\n{"ok":true}\n```', exitCode: 0, durationMs: 1 })
    const record = await runWorkflow(
      spec([{ id: 'ask', executor: { harness: 'codex' }, prompt: 'go', output: { type: 'json' }, on_fail: { retry: 1 } }]),
      { cwd: dir }
    )
    expect(record.status).toBe('passed')
    expect(prompts[1]).toBe('go')
  })

  it('runs the shipped data-pipeline example end to end into a real sqlite file', async () => {
    const example = loadWorkflow(join(process.cwd(), 'examples', 'data-pipeline.yaml'))
    const record = await runWorkflow(example, { cwd: dir })
    expect(record.status).toBe('passed')
    expect(record.steps.map((s) => s.stepId)).toEqual(['fetch', 'convert', 'store'])
    expect(record.steps[1].output).toEqual([
      { id: 1, name: 'fern', cents: 1250 },
      { id: 2, name: 'moss', cents: 400 }
    ])
    expect(record.steps[2].output).toEqual({ inserted: 2 })

    const db = new DatabaseSync(join(dir, 'catalog.db'))
    const rows = db.prepare('SELECT id, name, cents FROM items ORDER BY id').all()
    db.close()
    expect(rows).toEqual([
      { id: 1, name: 'fern', cents: 1250 },
      { id: 2, name: 'moss', cents: 400 }
    ])
  })
})
