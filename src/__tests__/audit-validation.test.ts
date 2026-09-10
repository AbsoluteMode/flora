import { describe, expect, it } from 'vitest'
import { buildContext, lookup } from '../context'
import { resolveParams, validateWorkflow } from '../workflow'
import { parseUsage } from '../adapters/usage'
import type { StepSpec, WorkflowSpec } from '../types'

const workflow = (step: unknown): WorkflowSpec => ({ name: 'validation', steps: [step as StepSpec] })
const command = { id: 'work', executor: { harness: 'command' }, run: 'echo ok' }

describe('workflow input boundaries', () => {
  it.each([
    ['numeric command', { ...command, run: 42 }],
    ['numeric prompt', { id: 'work', executor: { harness: 'claude-code' }, prompt: 42 }],
    ['non-string check', { ...command, verify: [{ type: 'command', run: 42 }] }],
    ['non-string expectation', { ...command, verify: [{ type: 'artifact', path: 'proof', contains: 42 }] }],
    ['infinite timeout', { ...command, executor: { harness: 'command', timeout_min: Infinity } }],
    ['invalid output schema', { ...command, output: { type: 'json', schema: { type: 'not-a-type' } } }],
    ['invalid schema regex', { ...command, output: { type: 'json', schema: { type: 'string', pattern: '[' } } }]
  ])('rejects %s before an executor can run', (_label, step) => {
    expect(() => validateWorkflow(workflow(step))).toThrow()
  })

  it('keeps __proto__ as an ordinary step and parameter key in serialized context', () => {
    const params = resolveParams({ name: 'test', params: JSON.parse('{"__proto__":{"default":"value"}}'), steps: [command] }, {})
    expect(Object.hasOwn(params, '__proto__')).toBe(true)
    const context = buildContext(params, [{ stepId: '__proto__', attempt: 1, status: 'passed', checks: [], output: { value: 42 } }])
    expect(JSON.parse(JSON.stringify(context)).steps.__proto__.output.value).toBe(42)
    expect(lookup(context, 'steps.__proto__.output.value')).toBe(42)
    expect(lookup(context, 'params.constructor')).toBeUndefined()
  })
})

describe('untrusted usage transcripts', () => {
  it('handles deeply nested JSON without overflowing the call stack', () => {
    const text = '{"nested":'.repeat(12_000) + '1' + '}'.repeat(12_000)
    expect(() => parseUsage(text)).not.toThrow()
  })
  it('retains reported calls/cost even when no token count is available', () => {
    expect(parseUsage('{"usage":{"calls":3,"cost_usd":0.25}}')).toMatchObject({ calls: 3, costUsd: 0.25 })
  })
  it('does not return non-finite counters', () => {
    const huge = '9'.repeat(400)
    expect(parseUsage(`{"usage":{"input_tokens":"${huge}","output_tokens":1}}`)?.inputTokens).toBeUndefined()
  })
})
