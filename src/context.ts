import type { StepResult } from './types'

/**
 * What a step can see of the run so far: the parameters it was started with
 * and the output of every step that already finished. This is both the source
 * for `{{…}}` substitutions and the document written to `$FLORA_CONTEXT`.
 */
export interface RunContext {
  params: Record<string, string>
  steps: Record<
    string,
    { status: string; output?: unknown; outputs?: unknown[]; patches?: Array<string | null> }
  >
  /** The event that triggered this run (`flora watch`), when there was one. */
  event?: unknown
}

export function buildContext(params: Record<string, string>, steps: StepResult[], event?: unknown): RunContext {
  const context: RunContext = { params, steps: Object.create(null) }
  for (const step of steps) {
    if (step.branches) {
      // A parallel step has no single output — only the array, so nobody
      // accidentally takes "the first one".
      context.steps[step.stepId] = { status: step.status, outputs: step.outputs ?? [], patches: step.patches ?? [] }
      continue
    }
    if (step.status === 'skipped') {
      context.steps[step.stepId] = { status: 'skipped' }
      continue
    }
    // A step without an output contract still exposes what it printed.
    context.steps[step.stepId] = {
      status: step.status,
      output: step.output !== undefined ? step.output : step.evidence?.output
    }
  }
  if (event !== undefined) context.event = event
  return context
}

const ROOTS = new Set(['params', 'steps', 'event'])

/**
 * `a.b[0].c` → ['a', 'b', '0', 'c']. Dots and integer indices only — no
 * expressions, no quoting, nothing that could ever need eval. Returns null
 * for anything else so the placeholder is left alone.
 */
export function parsePath(path: string): string[] | null {
  const segments: string[] = []
  const pattern = /^(?:([A-Za-z_][\w-]*)|\[(\d+)\])/
  let rest = path.trim()
  let first = true
  while (rest.length) {
    if (!first) {
      if (rest.startsWith('.')) rest = rest.slice(1)
      else if (!rest.startsWith('[')) return null
    }
    const match = pattern.exec(rest)
    if (!match) return null
    segments.push(match[1] ?? match[2])
    rest = rest.slice(match[0].length)
    first = false
  }
  return segments.length ? segments : null
}

/** Walk a parsed path down a value; undefined the moment a segment is missing. */
export function resolvePath(root: unknown, segments: string[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** `{{steps.fetch.output.items[0].id}}` → the value; a bare `{{task}}` means `{{params.task}}`. */
export function lookup(context: RunContext, path: string): unknown {
  const segments = parsePath(path)
  if (!segments) return undefined
  if (!ROOTS.has(segments[0])) segments.unshift('params')
  return resolvePath(context, segments)
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.\[\]-]*)\s*\}\}/g

/**
 * Substitute every placeholder that resolves; leave the rest exactly as
 * written. Objects and arrays are inlined as JSON.
 */
export function substituteContext(text: string, context: RunContext): string {
  return text.replace(PLACEHOLDER, (whole, path: string) => {
    const value = lookup(context, path)
    if (value === undefined) return whole
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
    return JSON.stringify(value)
  })
}

/**
 * Does the text reference data a harness or the outside world produced —
 * step outputs or a trigger event? Used to keep both out of shell commands.
 */
export function referencesSteps(text: string | undefined): boolean {
  if (!text) return false
  return /\{\{\s*(steps|event)\b/.test(text)
}
