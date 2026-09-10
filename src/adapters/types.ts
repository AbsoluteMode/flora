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

/** An adapter turns one harness into a callable unit: input in, evidence out. */
export interface HarnessAdapter {
  name: string
  execute(input: ExecuteInput): Promise<Evidence>
}
