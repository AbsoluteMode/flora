import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'

/**
 * The workflow contract as a JSON Schema — the same rules `validateWorkflow`
 * enforces in code, in a form editors and agents can read. Hand-written; a
 * test corpus keeps the two in agreement.
 */
export const SCHEMA_PATH = resolve(fileURLToPath(import.meta.url), '../../schema/workflow.schema.json')

type Schema = Record<string, unknown>

export const workflowSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Schema

export interface ContractError {
  /** `steps[1].output.type`; empty for the document itself. */
  path: string
  message: string
}

const ajv = new Ajv({ allErrors: true, strict: false })
let validator: ValidateFunction | null = null

/** Every way the document departs from the schema, addressed by field. */
export function schemaErrors(spec: unknown): ContractError[] {
  validator ??= ajv.compile(workflowSchema)
  if (validator(spec)) return []
  const seen = new Set<string>()
  const errors: ContractError[] = []
  for (const error of validator.errors ?? []) {
    // `if` only says "the then-branch applies"; the real complaint follows it.
    if (error.keyword === 'if') continue
    const entry = toContractError(error)
    const key = `${entry.path} ${entry.message}`
    if (seen.has(key)) continue
    seen.add(key)
    errors.push(entry)
  }
  return errors
}

function toContractError(error: ErrorObject): ContractError {
  const path = error.instancePath
    .replace(/\/(\d+)(?=\/|$)/g, '[$1]')
    .replace(/^\//, '')
    .replace(/\//g, '.')
  const params = error.params as Record<string, unknown>
  let message = error.message ?? 'invalid'
  if (error.keyword === 'additionalProperties') message = `unknown field "${String(params.additionalProperty)}"`
  else if (error.keyword === 'enum') message = `must be one of: ${(params.allowedValues as unknown[]).join(', ')}`
  else if (error.keyword === 'required') message = `missing required field "${String(params.missingProperty)}"`
  else if (error.keyword === 'not') {
    message = error.instancePath.endsWith('/name')
      ? 'is a reserved name'
      : 'must not reference {{steps.*}} or {{event.*}} here — read $FLORA_CONTEXT instead'
  }
  return { path, message }
}

/**
 * A compact, human- and agent-readable rendering of the schema: every field,
 * its type, whether it is required, and what it means. Generated from the
 * same document, so it cannot drift from it.
 */
export function describeContract(): string {
  const definitions = (workflowSchema.definitions ?? {}) as Record<string, Schema>
  const lines: string[] = []
  const section = (title: string, schema: Schema): void => {
    lines.push(`${title}${schema.description ? ` — ${String(schema.description)}` : ''}`)
    const required = new Set((schema.required as string[] | undefined) ?? [])
    for (const [name, raw] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
      const field = raw.$ref ? definitions[String(raw.$ref).replace('#/definitions/', '')] ?? raw : raw
      const type = describeType(raw, field)
      const note = raw.description ?? (raw.$ref ? undefined : field.description)
      lines.push(`  ${name}${required.has(name) ? '*' : ''}: ${type}${note ? ` — ${String(note)}` : ''}`)
    }
    lines.push('')
  }

  section('workflow', workflowSchema)
  for (const name of ['step', 'parallel', 'branch', 'executor', 'check', 'output', 'param', 'tool', 'trigger', 'sentry_source', 'command_source']) {
    if (definitions[name]) section(name, definitions[name])
  }
  lines.push('* = required. Placeholders: {{params.name}} (or {{name}}) anywhere; {{workflow_dir}} = the folder the workflow file is in (its scripts and prompts travel with it — see flora pack); {{steps.<id>.output…}} in prompt, contains and expect_match only.')
  return lines.join('\n')
}

function describeType(raw: Schema, resolved: Schema): string {
  if (raw.$ref) return String(raw.$ref).replace('#/definitions/', '')
  if (Array.isArray(raw.enum)) return (raw.enum as unknown[]).join(' | ')
  if (raw.type === 'array') {
    const items = raw.items as Schema | undefined
    const inner = items?.$ref ? String(items.$ref).replace('#/definitions/', '') : String(items?.type ?? 'any')
    return `list of ${inner}`
  }
  if (raw.type === 'object' && raw.additionalProperties && typeof raw.additionalProperties === 'object') {
    const value = raw.additionalProperties as Schema
    return `map of ${value.$ref ? String(value.$ref).replace('#/definitions/', '') : String(value.type ?? 'any')}`
  }
  return String(resolved.type ?? raw.type ?? 'any')
}
