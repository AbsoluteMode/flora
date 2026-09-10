import Ajv, { type ValidateFunction } from 'ajv'
import type { OutputSpec } from './types'

/** Larger than this and a step's output is a file, not a value. */
export const OUTPUT_LIMIT_BYTES = 256 * 1024

/** Appended to an agent's prompt when the step expects JSON back. */
export const OUTPUT_INSTRUCTION =
  'When you are done, finish your answer with exactly one ```json code block containing the result and nothing after it.'

export type OutputResult = { ok: true; value: unknown } | { ok: false; error: string }

export function withOutputInstruction(prompt: string, output?: OutputSpec): string {
  if ((output?.type ?? 'text') !== 'json') return prompt
  return `${prompt.trimEnd()}\n\n${OUTPUT_INSTRUCTION}`
}

/**
 * Turn what an executor printed into the step's output value, or explain why
 * it does not satisfy the contract. No contract → no value (the raw text is
 * still in the evidence, and the run context falls back to it).
 */
export function readOutput(raw: string, spec: OutputSpec | undefined, harness: string): OutputResult {
  if (!spec) return { ok: true, value: undefined }

  if ((spec.type ?? 'text') === 'text') {
    const tooBig = overLimit(raw)
    return tooBig ? { ok: false, error: tooBig } : { ok: true, value: raw }
  }

  // A command's whole stdout is the document. An agent's transcript is prose
  // with a fenced block at the end — take the last block that parses. The
  // same fallback rescues a command whose stderr got mixed into the output.
  const candidates = harness === 'command' ? [raw.trim(), ...jsonBlocks(raw)] : jsonBlocks(raw)
  let parsed: unknown
  let found = false
  let lastError = ''
  for (const text of candidates) {
    const tooBig = overLimit(text)
    if (tooBig) return { ok: false, error: tooBig }
    try {
      parsed = JSON.parse(text)
      found = true
      break
    } catch (err) {
      lastError = (err as Error).message
    }
  }
  if (!found) {
    return {
      ok: false,
      error: candidates.length
        ? `output is not valid JSON: ${lastError}`
        : 'no JSON block found in the output (expected a ```json fenced block)'
    }
  }

  if (spec.schema) {
    const validate = compile(spec.schema)
    if (!validate(parsed)) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
        .join('; ')
      return { ok: false, error: `output does not match the schema: ${detail}` }
    }
  }
  return { ok: true, value: parsed }
}

function overLimit(text: string): string | null {
  const bytes = Buffer.byteLength(text, 'utf8')
  return bytes > OUTPUT_LIMIT_BYTES ? `output exceeds ${OUTPUT_LIMIT_BYTES / 1024}KB (${bytes} bytes)` : null
}

/**
 * JSON candidates from a transcript, last first: fenced ```json blocks, then
 * plain ``` fences, then the trailing object/array if the text ends with one.
 */
function jsonBlocks(text: string): string[] {
  const fenced: string[] = []
  const fence = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) fenced.push(match[1].trim())
  const candidates = fenced.reverse()

  const trimmed = text.trim()
  const tailStart = Math.max(trimmed.lastIndexOf('\n{'), trimmed.lastIndexOf('\n['))
  if (tailStart >= 0) candidates.push(trimmed.slice(tailStart + 1))
  else if (/^[[{]/.test(trimmed)) candidates.push(trimmed)
  return candidates
}

const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false })
const compiled = new WeakMap<object, ValidateFunction>()

/** Validate/compile before execution so a broken contract cannot fail after side effects. */
export function assertOutputSchema(schema: Record<string, unknown>): void { compile(schema) }

function compile(schema: Record<string, unknown>): ValidateFunction {
  let validate = compiled.get(schema)
  if (!validate) {
    validate = ajv.compile(schema)
    compiled.set(schema, validate)
  }
  return validate
}
