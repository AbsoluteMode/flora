import { describe, expect, it, vi } from 'vitest'
import { filterCalls, loadCall, loadInspection, parsePreview, readableError, readArtifactText, resolveArtifact } from '../../web/inspection-data.js'

const artifact = (path: string, source = path) => ({ path, source, bytes: 100 })
const run = { runId: 'example', params: { topic: 'example' }, steps: [{ stepId: 'collect', status: 'passed', output: [{ id: 'item-1', text: 'Input example' }] }] }
const files = [
  artifact('classify/capture/stages/classify.json'), artifact('classify/analysis/classify/index.json'),
  artifact('classify/capture/input.jsonl'), artifact('classify/result.jsonl'),
  artifact('classify/traces/classify/call-1.json'), artifact('classify/traces/systems/system.txt')
]
const step = { stepId: 'classify', harness: 'command', command: 'node classify.mjs', status: 'passed', inputsFrom: ['collect'], output: { count: 1 }, artifacts: files }
const contents: Record<string, string> = {
  [files[0].path]: JSON.stringify({ format: 1, inputs: [{ name: 'records', path: 'capture/input.jsonl' }], outputs: [{ name: 'labels', path: 'result.jsonl' }], coverage: { completeModelHistory: true } }),
  [files[1].path]: JSON.stringify({ format: 1, calls: [{ callId: 'call-1', tag: 'classify:item-1', traceFile: 'traces/classify/call-1.json', status: 'ok', model: 'example-model', mentionedIds: ['item-1'] }] }),
  [files[4].path]: JSON.stringify({ format: 1, callId: 'call-1', tag: 'classify:item-1', backend: 'example', status: 'ok', request: { systemFile: 'traces/systems/system.txt', user: '{"id":"item-1"}' }, response: { text: '{"label":"keep"}', model: 'example-model', usage: { input_tokens: 10, output_tokens: 4 } } }),
  [files[5].path]: 'Label the supplied record.'
}
const read = async (file: { path: string }) => {
  if (!(file.path in contents)) throw new Error('missing fixture: ' + file.path)
  return contents[file.path]
}

describe('declared artifact references', () => {
  it('resolves workspace-relative references within the copied step namespace', () => {
    expect(resolveArtifact('traces/systems/system.txt', files, files[4].path)?.path).toBe(files[5].path)
  })
  it.each(['../secret', '/private.txt', 'https://example.invalid/private', 'C:\\private.txt', 'file:///private', 'missing.txt'])('refuses %s', (value) => {
    expect(resolveArtifact(value, files, files[4].path)).toBeNull()
  })
  it('does not guess between ambiguous suffixes', () => {
    expect(resolveArtifact('data.json', [artifact('a/data.json'), artifact('b/data.json')])).toBeNull()
  })
  it('keeps a nested generic descriptor in its branch namespace', () => {
    const branches = [artifact('classify-0/evidence/input.json'), artifact('classify-1/evidence/input.json')]
    expect(resolveArtifact('evidence/input.json', branches, 'classify-1/evidence/inspection.json')).toBe(branches[1])
  })
})

it('prefers declared input/output snapshots and lists calls without fetching all their bodies', async () => {
  const spy = vi.fn(read)
  const result = await loadInspection(run, step, spy)
  expect(result.inputs[0].artifact?.path).toBe(files[2].path)
  expect(result.outputs[0].artifact?.path).toBe(files[3].path)
  expect(result.outputs.some((source) => source.artifact?.path === files[2].path)).toBe(false)
  expect(result.calls).toHaveLength(1)
  expect(result.calls[0]).toMatchObject({ id: 'call-1', label: 'classify:item-1', status: 'passed' })
  expect(spy.mock.calls.some(([file]) => file.path === files[4].path)).toBe(false)
  const call = await loadCall(result.calls[0], files, read)
  expect(call).toMatchObject({ input: '{"id":"item-1"}', prompt: 'Label the supplied record.', output: '{"label":"keep"}', model: 'example-model' })
})

it('supports a generic inspection descriptor with inline values and calls', async () => {
  const control = artifact('step/inspection.json')
  const result = await loadInspection(run, { ...step, artifacts: [control] }, async () => JSON.stringify({
    format: 'flora-inspection', version: 1, inputs: [{ label: 'Records', value: [{ id: 1 }] }],
    outputs: [{ label: 'Answer', value: { accepted: true } }],
    calls: [{ id: 'c', label: 'Record 1', request: { system: 'Classify.', user: 'Record 1' }, response: { text: 'keep' }, status: 'ok' }]
  }))
  expect(result.inputs[0].value).toEqual([{ id: 1 }])
  expect((await loadCall(result.calls[0], [control], async () => '')).output).toBe('keep')
})

it('distinguishes upstream/parameter values from missing captured file inputs', async () => {
  const result = await loadInspection(run, { ...step, prompt: 'Inspect records', artifacts: [] }, read)
  expect(result.inputOrigin).toBe('upstream')
  expect(result.inputs[0]).toMatchObject({ label: 'collect', value: run.steps[0].output })
  expect(result.calls).toEqual([])
})

it('surfaces incomplete history, missing references and broken control files', async () => {
  const result = await loadInspection(run, step, async (file) => file.path.includes('/capture/stages/')
    ? JSON.stringify({ inputs: [{ name: 'lost input', path: 'not-in-archive.json' }], coverage: { completeModelHistory: false } })
    : '{broken')
  expect(result.inputs[0].problem).toMatch(/not included/)
  expect(result.warnings.join(' ')).toMatch(/not recorded/)
  expect(result.warnings.join(' ')).toMatch(/could not read/i)
})

it('falls back to lazily readable trace files when an index is absent', async () => {
  const result = await loadInspection(run, { ...step, artifacts: files.slice(4) }, read)
  expect(result.calls).toHaveLength(1)
  expect((await loadCall(result.calls[0], files, read)).prompt).toBe('Label the supplied record.')
})

it('filters call metadata by record ID and normalized failure status', () => {
  const calls = [{ key: '1', id: 'a', label: 'first', status: 'failed', recordIds: ['item-2'] }, { key: '2', id: 'b', label: 'second', status: 'passed', recordIds: [] }]
  expect(filterCalls(calls, 'ITEM-2', 'failed').map((call) => call.key)).toEqual(['1'])
})

it('parses JSONL items and keeps malformed data visible as text', () => {
  expect(parsePreview('{"id":1}\n{"id":2}\n', 'records.jsonl').value).toEqual([{ id: 1 }, { id: 2 }])
  expect(parsePreview('{bad}', 'records.json')).toMatchObject({ kind: 'text', text: '{bad}' })
})

it('bounds artifact response bodies even when saved metadata lies', async () => {
  const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0]) => new Response('x'.repeat(33)))
  await expect(readArtifactText('run', artifact('step/file.txt'), { fetcher, maxBytes: 32 })).rejects.toThrow(/too large/)
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/runs/run/artifacts/step/file.txt')
})

it('passes cancellation to fetch and rejects an interrupted load', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(readArtifactText('run', artifact('step/file'), { signal: controller.signal })).rejects.toThrow()
})

it('reads an entire fenced JSON response while preserving its exact original', () => {
  const original = '```json\n{"answer":"keep"}\n```'
  expect(parsePreview(original)).toMatchObject({ kind: 'json', framed: true, value: { answer: 'keep' }, text: original })
  expect(parsePreview('Explanation\n' + original).kind).toBe('text')
  expect(parsePreview(original, 'report.md').kind).toBe('markdown')
})

it('extracts the reported reason from a CLI transcript tail without inventing one', () => {
  const tail = 'CLI exited 1: tokens":123,"result":' + JSON.stringify('The service could not process this request.\nRequest ID: example') + ',"duration_ms":12}'
  expect(readableError(tail)).toBe('The service could not process this request.\nRequest ID: example')
  expect(readableError('The response was not valid JSON.')).toBe('The response was not valid JSON.')
})

it('keeps malformed technical error payloads out of the plain-language summary', () => {
  expect(readableError('CLI exited 1: {"result":"unfinished')).toBe('This request did not produce a usable response. Open the error details for the original message.')
})
