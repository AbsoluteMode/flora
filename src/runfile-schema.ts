import { z } from 'zod'
import type { RunRecord } from './types'
import type { StoredEvent } from './state'
import { validateFileName, validateRelativePath } from './safe-path'
import { WorkflowError } from './workflow'

const finite = z.number().finite()
const pathCheck = (validate: (value: string) => void) => z.string().refine((value) => {
  try { validate(value); return true } catch { return false }
}, 'invalid path')
const usage = z.object(Object.fromEntries([
  'inputTokens', 'outputTokens', 'cachedTokens', 'contextTokens', 'totalTokens', 'limitPct', 'calls', 'costUsd'
].map((name) => [name, finite.optional()]))).passthrough()
const evidence = z.object({
  output: z.string(), exitCode: finite.int().nullable(), durationMs: finite,
  costUsd: finite.optional(), usage: usage.optional(), stalled: z.boolean().optional(), timedOut: z.boolean().optional()
}).passthrough()
const stepStatus = z.enum(['pending', 'running', 'verifying', 'passed', 'failed', 'skipped'])
const check = z.object({
  type: z.enum(['command', 'artifact']), run: z.string().optional(), expect_exit: finite.int().optional(),
  expect_match: z.string().optional(), path: z.string().optional(), contains: z.string().optional()
}).passthrough()

function stepSchema(depth: number): z.ZodType {
  return z.object({
    stepId: z.string().min(1), status: stepStatus, attempt: finite.int().nonnegative(),
    title: z.string().optional(), harness: z.string().optional(), evidence: evidence.optional(),
    checks: z.array(z.object({ check: check.optional(), passed: z.boolean(), detail: z.string() }).passthrough()),
    output: z.unknown().optional(), outputError: z.string().optional(), error: z.string().optional(),
    skipReason: z.string().optional(), verifiedIn: z.literal('worktree').optional(),
    branches: depth > 0 ? z.array(stepSchema(depth - 1)).optional() : z.never().optional(),
    outputs: z.array(z.unknown()).optional(), patches: z.array(z.string().nullable()).optional(),
    priorAttempts: z.array(z.object({ attempt: finite.int().nonnegative(), status: stepStatus, evidence: evidence.partial().optional() }).passthrough()).optional(),
    inputsFrom: z.array(z.string()).optional(), metrics: z.record(z.string(), finite).optional(),
    outputBytes: finite.int().nonnegative().optional(), prompt: z.string().optional(), command: z.string().optional(),
    artifacts: z.array(z.object({ path: pathCheck(validateRelativePath), source: z.string(), bytes: finite.int().nonnegative() }).passthrough()).optional()
  }).passthrough()
}

const runSchema = z.object({
  runId: pathCheck(validateFileName), workflow: z.string().min(1), cwd: z.string(),
  params: z.record(z.string(), z.string()), status: z.enum(['running', 'passed', 'failed', 'error', 'interrupted']),
  startedAt: z.string(), finishedAt: z.string().optional(), steps: z.array(stepSchema(8)),
  parentRunId: z.string().optional(), trigger: z.object({ source: z.string(), id: z.string() }).passthrough().optional()
}).passthrough()
const eventSchema = z.object({
  seq: finite.int().nonnegative().optional(), at: z.string(), type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  payload: z.record(z.string(), z.unknown())
}).passthrough()

/** Protect consumers that serialize/render nested JSON, including unknown future fields. */
function checkDepth(value: unknown): void {
  const pending: Array<[unknown, number]> = [[value, 0]]
  while (pending.length) {
    const [item, depth] = pending.pop()!
    if (!item || typeof item !== 'object') continue
    if (depth > 128) throw new WorkflowError('invalid run data: JSON nesting exceeds 128 levels')
    for (const child of Object.values(item)) pending.push([child, depth + 1])
  }
}

export function validateRunRecord(value: unknown): RunRecord {
  checkDepth(value)
  const parsed = runSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowError(`invalid run record: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`)
  // Preserve unknown fields for forward-compatible sharing; known consumer fields were checked above.
  return value as RunRecord
}

export function validateRunEvent(value: unknown): StoredEvent {
  checkDepth(value)
  const parsed = eventSchema.safeParse(value)
  if (!parsed.success) throw new WorkflowError(`invalid run event: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`)
  return value as StoredEvent
}
