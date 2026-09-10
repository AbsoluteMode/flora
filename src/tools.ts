import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolSpec } from './types'
import { substitute } from './workflow'

/** The CLI entry, so a step can hand its harness a `flora mcp` server to spawn. */
export const FLORA_BIN = resolve(fileURLToPath(import.meta.url), '../../bin/flora.mjs')

/** How deep call_workflow may nest runs (root run = depth 0). `FLORA_MAX_DEPTH` overrides. */
export const DEFAULT_MAX_DEPTH = 3

export function maxDepth(): number {
  const raw = Number(process.env.FLORA_MAX_DEPTH)
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_MAX_DEPTH
}

/** One MCP server a harness should start for the step, in the shape every harness understands. */
export interface McpServerEntry {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface ToolContext {
  params: Record<string, string>
  /** The $FLORA_CONTEXT file of the running step. */
  contextPath: string
  cwd: string
  runId: string
  /** Depth of the run this step belongs to. */
  depth: number
  /** Workflow files from the root run down to this one, for cycle detection. */
  stack: string[]
}

/**
 * Turn a step's `tools:` contract into MCP servers. External servers pass
 * through with `{{params.*}}` substituted; the flora-native tools become one
 * more stdio server — this very CLI, started with the step's context and the
 * nesting bookkeeping call_workflow needs.
 */
export function mcpServersFor(tools: ToolSpec[] | undefined, context: ToolContext): McpServerEntry[] {
  if (!tools?.length) return []
  const entries: McpServerEntry[] = []
  const allowedWorkflows: string[] = []
  let native = false

  for (const tool of tools) {
    if ('mcp' in tool) {
      entries.push({
        name: tool.mcp.name,
        command: substitute(tool.mcp.command, context.params),
        args: (tool.mcp.args ?? []).map((arg) => substitute(arg, context.params)),
        env: Object.fromEntries(
          Object.entries(tool.mcp.env ?? {}).map(([key, value]) => [key, substitute(value, context.params)])
        )
      })
      continue
    }
    native = true
    if (tool.flora === 'call_workflow') {
      allowedWorkflows.push(resolve(context.cwd, substitute(tool.workflow, context.params)))
    }
  }

  if (native) {
    const args = [
      FLORA_BIN,
      'mcp',
      '--context',
      context.contextPath,
      '--cwd',
      context.cwd,
      '--run',
      context.runId,
      '--depth',
      String(context.depth + 1)
    ]
    if (context.stack.length) args.push('--stack', context.stack.join(delimiter))
    for (const workflow of allowedWorkflows) args.push('--allow-workflow', workflow)
    entries.push({ name: 'flora', command: process.execPath, args, env: {} })
  }
  return entries
}

/** Claude Code's permission name for "every tool this server offers". */
export const allowedToolPatterns = (servers: McpServerEntry[]): string[] => servers.map((s) => `mcp__${s.name}`)

/** The JSON Claude Code reads from `--mcp-config`. */
export function claudeMcpConfig(servers: McpServerEntry[]): string {
  const mcpServers: Record<string, unknown> = Object.create(null)
  for (const server of servers) {
    mcpServers[server.name] = {
      type: 'stdio',
      command: server.command,
      args: server.args,
      ...(Object.keys(server.env).length ? { env: server.env } : {})
    }
  }
  return JSON.stringify({ mcpServers }, null, 2)
}

/**
 * Codex takes the same thing as inline TOML config overrides, one per server:
 * `-c mcp_servers.<name>={command="…",args=["…"],env={K="v"}}`.
 */
export function codexMcpArgs(servers: McpServerEntry[]): string[] {
  const args: string[] = []
  for (const server of servers) {
    const parts = [`command=${tomlString(server.command)}`, `args=[${server.args.map(tomlString).join(',')}]`]
    const env = Object.entries(server.env)
    if (env.length) parts.push(`env={${env.map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)}=${tomlString(v)}`).join(',')}}`)
    args.push('-c', `mcp_servers.${server.name}={${parts.join(',')}}`)
  }
  return args
}

/** TOML basic strings escape the same way JSON strings do for everything a path or flag can hold. */
const tomlString = (value: string): string => JSON.stringify(value)
