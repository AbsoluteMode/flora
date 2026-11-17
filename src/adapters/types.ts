import type { Evidence, ExecutorSpec, OutputSpec } from '../types'
import type { McpServerEntry } from '../tools'

export interface ExecuteInput {
  runId?: string
  stepId?: string
  spec: ExecutorSpec
  /** Task text for harness adapters. */
  prompt?: string
  /** Shell command for the `command` adapter. */
  run?: string
  cwd: string
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
  /** Extra environment for the child — the engine passes FLORA_CONTEXT here. */
  env?: Record<string, string>
  /** The step's output contract, so agent adapters can ask for JSON. */
  output?: OutputSpec
  /** MCP servers the harness must start for this step, and nothing else. */
  mcp?: McpServerEntry[]
}

/** A session id flora will put on a command line: a plain token, never something that reads as a flag. */
export const SESSION_ID = /^[A-Za-z0-9][\w.:-]{0,127}$/

/**
 * An output repair request: `prompt` is flora's repair message, sent as is
 * (no output instruction appended — it carries its own). With `sessionId` the
 * adapter continues that session of the harness; without one it starts a new
 * short request. Either way read-only and with no tools mounted: repair
 * changes the form of an answer, never the work.
 */
export interface RepairInput extends Omit<ExecuteInput, 'mcp'> {
  sessionId?: string
}

/** An adapter turns one harness into a callable unit: input in, evidence out. */
export interface HarnessAdapter {
  name: string
  execute(input: ExecuteInput): Promise<Evidence>
  /**
   * Ask the same agent to fix the form of its answer. Adapters that can
   * resume a session implement it; for the rest the engine sends one fresh
   * request through `execute` instead.
   */
  repair?(input: RepairInput): Promise<Evidence>
}
