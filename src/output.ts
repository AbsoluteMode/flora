import Ajv, { type ValidateFunction } from 'ajv'
import type { OutputIssue, OutputSpec } from './types'

/** Larger than this and a step's output is a file, not a value. */
export const OUTPUT_LIMIT_BYTES = 256 * 1024

/** Appended to an agent's prompt when the step expects JSON back. */
export const OUTPUT_INSTRUCTION =
  'When you are done, finish your answer with exactly one ```json code block containing the result and nothing after it.'

export type OutputResult =
  | { ok: true; value: unknown }
  | {
      ok: false
      error: string
      /** The same problem per place in the value (schema errors), or one entry for the whole answer. */
      issues: OutputIssue[]
      /** A form problem an agent can fix by answering again (not JSON, no block, schema) — not a size overrun. */
      repairable: boolean
    }

// WHY: docs/decisions/2026-11-15-output-repair.md
/**
 * Appended to an agent's prompt when the step expects JSON back: the block
 * instruction and, when the contract has one, the schema itself — the agent
 * cannot meet a contract it never saw.
 */
export function withOutputInstruction(prompt: string, output?: OutputSpec): string {
  if ((output?.type ?? 'text') !== 'json') return prompt
  const schema = output?.schema ? `\n${schemaInstruction(output.schema)}` : ''
  return `${prompt.trimEnd()}\n\n${OUTPUT_INSTRUCTION}${schema}`
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return `The JSON value must match this JSON Schema, including the type of every field:\n\`\`\`json schema\n${JSON.stringify(schema, null, 2)}\n\`\`\``
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
    return tooBig ? failure(tooBig, false) : { ok: true, value: raw }
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
    if (tooBig) return failure(tooBig, false)
    try {
      parsed = JSON.parse(text)
      found = true
      break
    } catch (err) {
      lastError = (err as Error).message
    }
  }
  if (!found) {
    return failure(
      !raw.trim()
        ? 'the output is empty (expected a ```json fenced block)'
        : candidates.length
          ? `output is not valid JSON: ${lastError}`
          : 'no JSON block found in the output (expected a ```json fenced block)',
      true
    )
  }

  if (spec.schema) {
    const validate = compile(spec.schema)
    if (!validate(parsed)) {
      const issues = (validate.errors ?? []).map((e) => ({ path: e.instancePath || '/', message: e.message ?? 'invalid' }))
      const detail = issues.map((i) => `${i.path} ${i.message}`).join('; ')
      return { ok: false, error: `output does not match the schema: ${detail}`, issues, repairable: true }
    }
  }
  return { ok: true, value: parsed }
}

function failure(error: string, repairable: boolean): OutputResult {
  return { ok: false, error, issues: [{ path: '', message: error }], repairable }
}

/** How much of an invalid answer a fresh repair request quotes back. */
export const REPAIR_QUOTE_BYTES = 32 * 1024

export interface RepairRequest {
  /** `resume`: the message continues the agent's own session; `fresh`: a new request that quotes the answer. */
  mode: 'resume' | 'fresh'
  issues: OutputIssue[]
  output?: OutputSpec
  /** The invalid answer — quoted only in a fresh request, where the agent has not seen it. */
  previous?: string
}

/**
 * The message an agent gets when its answer broke the output contract: what
 * is wrong (path and reason, as the validator said it), the schema, and the
 * request to return the same result in the required form — not to redo the
 * work. Repair is a change of form, so the agent is told to leave files alone.
 */
export function repairPrompt(request: RepairRequest): string {
  const lines: string[] = []
  if (request.mode === 'resume') {
    lines.push('Your final answer did not match the output format this step requires, so flora could not accept it.')
  } else {
    lines.push(
      'An agent finished a task, but its final answer (quoted below) does not match the output format the task requires.',
      'You are only converting the form of that answer.'
    )
  }
  lines.push('', 'What is wrong (JSON pointer: problem):')
  for (const issue of request.issues) lines.push(`- ${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
  lines.push('')
  if (request.output?.schema) lines.push(schemaInstruction(request.output.schema), '')
  if (request.mode === 'fresh') {
    lines.push('The answer to convert:', '<<<', quote(request.previous ?? ''), '>>>', '')
  }
  lines.push(
    'Do not redo the work, do not change files and do not run commands; return the same result in the required form.',
    'Keep the content; change only its shape (types, structure, field names) to fit the contract.',
    OUTPUT_INSTRUCTION
  )
  return lines.join('\n')
}

function quote(text: string): string {
  if (!text.trim()) return '(empty)'
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= REPAIR_QUOTE_BYTES) return text
  // The block an agent writes is at the end of its answer: keep the tail.
  const tail = Buffer.from(text, 'utf8').subarray(bytes - REPAIR_QUOTE_BYTES).toString('utf8')
  return `[… ${bytes - REPAIR_QUOTE_BYTES} bytes earlier omitted]\n${tail}`
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
