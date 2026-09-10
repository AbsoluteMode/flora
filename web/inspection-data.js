// Read-only interpretation of records and declared artifacts. No producer paths are opened.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value, fallback = '') => typeof value === 'string' ? value : fallback
const own = (value, key) => object(value) && Object.hasOwn(value, key)
const relative = (value) => typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..')
const MAX_ITEMS = 2000
const statusOf = (value) => ['ok', 'passed', 'success'].includes(value) ? 'passed' : ['error', 'failed', 'invalid_json'].includes(value) ? 'failed' : ['running', 'pending'].includes(value) ? 'running' : 'unknown'

export function resolveArtifact(reference, artifacts, origin = '') {
  if (!relative(reference)) return null
  const exact = artifacts.find((file) => file.path === reference)
  if (exact) return exact
  const namespace = origin.includes('/') ? origin.slice(0, origin.indexOf('/')) : ''
  const local = namespace && artifacts.find((file) => file.path === namespace + '/' + reference)
  if (local) return local
  const marker = /(?:^|\/)(?:capture|analysis|traces|inspection|gui)\//.exec(origin)
  const root = marker ? origin.slice(0, marker.index) : origin.slice(0, origin.lastIndexOf('/'))
  const scoped = artifacts.find((file) => file.path === (root ? root + '/' : '') + reference)
  if (scoped) return scoped
  const matches = artifacts.filter((file) => file.path.endsWith('/' + reference) || file.source === reference)
  return matches.length === 1 ? matches[0] : null
}

export async function readArtifactText(runId, artifact, { fetcher = fetch, signal, maxBytes = 2 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted()
  if (!relative(artifact.path)) throw new Error('Invalid artifact path')
  const url = `/api/runs/${encodeURIComponent(runId)}/artifacts/${artifact.path.split('/').map(encodeURIComponent).join('/')}`
  const response = await fetcher(url, { signal })
  if (!response.ok) throw new Error(response.status === 404 ? 'This file was not included or is missing on this machine.' : `Could not read this file (HTTP ${response.status}).`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The file has no readable body.')
  const decoder = new TextDecoder()
  let bytes = 0, text = ''
  try {
    for (;;) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error('This file is too large for an inline preview. Open the raw file to read it.')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function parsePreview(text, path = '') {
  try {
    const framed = !path && /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text.trim())
    if (framed) return { kind: 'json', text, framed: true, value: JSON.parse(framed[1]) }
    if (/\.(jsonl|ndjson)$/i.test(path)) return { kind: 'json', text, value: text.split(/\r?\n/).filter((line) => line.trim()).map(JSON.parse) }
    if (/\.json$/i.test(path) || /^[\s]*[\[{]/.test(text)) return { kind: 'json', text, value: JSON.parse(text) }
  } catch {
    return { kind: 'text', text, problem: 'The saved content is not valid JSON. Showing the original text.' }
  }
  return { kind: /\.(md|markdown)$/i.test(path) ? 'markdown' : 'text', text }
}

function sources(items, artifacts, origin, prefix) {
  if (!Array.isArray(items)) return []
  return items.slice(0, MAX_ITEMS).filter(object).map((item, index) => {
    const label = string(item.label, string(item.name, `${prefix} ${index + 1}`))
    const key = `${prefix}:${origin}:${index}`
    if (own(item, 'value')) return { key, label, value: item.value }
    const reference = item.artifact ?? item.path
    const artifact = resolveArtifact(reference, artifacts, origin)
    return artifact ? { key, label, artifact } : { key, label, problem: 'The referenced file was not included in this run.' }
  })
}

function summary(raw, origin, artifacts, index) {
  const reference = raw.traceFile ?? raw.artifact
  const artifact = reference !== undefined ? resolveArtifact(reference, artifacts, origin) : null
  const inline = object(raw.request) || object(raw.response) ? raw : undefined
  const id = string(raw.callId, string(raw.id, `${index + 1}`))
  return {
    key: artifact?.path ?? `${origin}#${index}`, id, label: string(raw.tag, string(raw.label, `Call ${index + 1}`)),
    status: statusOf(raw.status), phase: string(raw.phase), parentCallId: string(raw.parentCallId),
    model: string(raw.model, string(raw.response?.model)), backend: string(raw.backend),
    usage: object(raw.usage) ? raw.usage : undefined, startedAt: string(raw.startedAt),
    recordIds: (Array.isArray(raw.recordIds) ? raw.recordIds : Array.isArray(raw.mentionedIds) ? raw.mentionedIds : []).filter((id) => typeof id === 'string'),
    ...(artifact ? { artifact } : {}), ...(inline ? { inline } : {}),
    ...(!artifact && !inline ? { problem: reference === undefined ? 'Only call metadata was saved. Its request and response were not recorded.' : 'The referenced call file was not included in this run.' } : {})
  }
}

function stepArtifacts(step) {
  return [...(Array.isArray(step.artifacts) ? step.artifacts : []), ...(Array.isArray(step.branches) ? step.branches.flatMap((branch) => Array.isArray(branch.artifacts) ? branch.artifacts : []) : [])]
    .filter((file) => object(file) && relative(file.path))
}

export async function loadInspection(run, step, read) {
  const artifacts = stepArtifacts(step)
  const warnings = []
  const calls = new Map()
  let inputs = [], outputs = [], inputOrigin = 'unavailable'
  const controls = artifacts.filter((file) => /(?:^|\/)inspection\.json$|(?:^|\/)capture\/stages\/[^/]+\.json$|(?:^|\/)(?:analysis|inspection)\/[^/]+\/index\.json$/.test(file.path))
  if (controls.length > 16) warnings.push('Only the first 16 inspection descriptors are shown.')
  for (const file of controls.slice(0, 16)) {
    try {
      const raw = JSON.parse(await read(file))
      if (!object(raw)) throw new Error('expected an object')
      inputs.push(...sources(raw.inputs, artifacts, file.path, 'Input'))
      outputs.push(...sources(raw.outputs, artifacts, file.path, 'Output'))
      if (raw.coverage?.completeModelHistory === false) warnings.push('Some original model calls were not recorded. Their prompts and responses are unavailable.')
      if (Array.isArray(raw.calls)) {
        if (raw.calls.length > MAX_ITEMS) warnings.push(`Only the first ${MAX_ITEMS} calls from this descriptor are shown.`)
        for (const [index, entry] of raw.calls.slice(0, MAX_ITEMS).entries()) {
          if (!object(entry)) continue
          const call = summary(entry, file.path, artifacts, index)
          calls.set(call.key, call)
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error
      warnings.push(`Could not read ${file.path}: ${error.message}`)
    }
  }
  if (inputs.length) inputOrigin = 'captured'
  else {
    inputs = (Array.isArray(step.inputsFrom) ? step.inputsFrom : []).flatMap((id) => {
      const previous = run.steps?.find((candidate) => candidate.stepId === id)
      if (!previous) return []
      return [{ key: 'upstream:' + id, label: String(id), value: previous.output ?? previous.evidence?.output ?? null }]
    })
    if (inputs.length) inputOrigin = 'upstream'
    if (object(run.params) && Object.keys(run.params).length) {
      inputs.push({ key: 'params', label: 'Run parameters', value: run.params })
      if (inputOrigin === 'unavailable') inputOrigin = 'parameters'
    }
  }
  const reported = own(step, 'output') && step.output !== undefined
  const value = reported && object(step.output) && own(step.output, 'execution') && own(step.output, 'result') && Array.isArray(step.output.artifacts) ? step.output.result : step.output
  if (reported) outputs.push({ key: 'reported', label: 'Reported step result', value })
  if (!outputs.length && typeof step.evidence?.output === 'string') outputs.push({ key: 'executor', label: 'Executor output', value: step.evidence.output, plainText: step.status === 'running' })
  const used = new Set([...inputs, ...outputs].map((source) => source.artifact?.path))
  for (const control of controls) used.add(control.path)
  for (const file of artifacts.filter((file) => !/(?:^|\/)(?:capture|analysis|traces|gui)\//.test(file.path) && /\.(jsonl?|ndjson|csv|txt|md|markdown)$/i.test(file.path))) {
    if (!used.has(file.path)) outputs.push({ key: 'file:' + file.path, label: file.path, artifact: file })
  }
  for (const branch of step.branches ?? []) {
    outputs.push({ key: 'branch:' + branch.stepId, label: `Branch: ${branch.title || branch.stepId}`, value: branch.output ?? branch.evidence?.output ?? null })
  }
  for (const file of artifacts.filter((file) => /(?:^|\/)traces\/(?!systems\/).+\.json$/.test(file.path)).slice(0, MAX_ITEMS)) {
    if (!calls.has(file.path)) calls.set(file.path, { key: file.path, id: file.path, label: file.path.split('/').at(-1).replace(/\.json$/, ''), status: 'unknown', artifact: file, recordIds: [] })
  }
  return { inputs, outputs, inputOrigin, artifacts, calls: [...calls.values()].slice(0, MAX_ITEMS), warnings: [...new Set(warnings)] }
}

export async function loadCall(call, artifacts, read) {
  if (call.problem) return { ...call, problem: call.problem }
  let raw = call.inline
  if (!raw && call.artifact) raw = JSON.parse(await read(call.artifact))
  if (!object(raw)) throw new Error('The saved call is not a JSON object.')
  const request = object(raw.request) ? raw.request : {}
  const response = object(raw.response) ? raw.response : {}
  let prompt = string(request.system, string(raw.prompt))
  const warnings = []
  if (request.systemFile !== undefined) {
    const file = resolveArtifact(request.systemFile, artifacts, call.artifact?.path)
    if (!file) warnings.push('The system prompt file was not included in this run.')
    else {
      try { prompt = await read(file) } catch (error) { if (error.name === 'AbortError') throw error; warnings.push(error.message) }
    }
  }
  return {
    ...call, id: string(raw.callId, string(raw.id, call.id)), label: string(raw.tag, string(raw.label, call.label)),
    status: raw.status === undefined ? call.status : statusOf(raw.status),
    input: request.user ?? request.input, prompt: prompt || undefined,
    output: own(response, 'text') ? response.text : response.output,
    model: string(response.model, string(raw.model, call.model)), backend: string(raw.backend, call.backend),
    usage: response.usage ?? raw.usage ?? call.usage, phase: string(raw.phase, call.phase), parentCallId: string(raw.parentCallId, call.parentCallId),
    startedAt: string(raw.startedAt), finishedAt: string(raw.finishedAt), error: string(raw.error),
    settings: raw.settings, transport: request.transport, warnings
  }
}

export function filterCalls(calls, query = '', status = 'all') {
  const needle = query.trim().toLocaleLowerCase()
  return calls.filter((call) => (status === 'all' || call.status === status) && (!needle || [call.id, call.label, call.model, call.backend, ...(call.recordIds ?? [])].filter((value) => typeof value === 'string').join(' ').toLocaleLowerCase().includes(needle)))
}

/** Extract a saved service message; the unmodified error remains available separately. */
export function readableError(error) {
  const text = string(error).trim()
  const match = /"(?:result|message)"\s*:\s*("(?:\\.|[^"\\])*")/.exec(text)
  if (match) {
    try { const value = JSON.parse(match[1]); if (value.trim()) return value.slice(0, 1200) } catch {}
  }
  if (text.length <= 600 && !/[{}]|"\w+"\s*:/.test(text)) return text
  return 'This request did not produce a usable response. Open the error details for the original message.'
}
