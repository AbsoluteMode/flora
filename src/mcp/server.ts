import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { lookup, type RunContext } from '../context'
import { describeContract, schemaErrors, type ContractError } from '../contract'
import { runWorkflow } from '../engine'
import { createRecorder } from '../recorder'
import { RunStore } from '../state'
import { maxDepth } from '../tools'
import { loadWorkflow, validateWorkflow, WorkflowError } from '../workflow'
import type { RunRecord, WorkflowSpec } from '../types'
import { floraVersion } from '../version'

export const MCP_SERVER_INFO = { name: 'flora', version: floraVersion() }

/**
 * When started by a step (`flora mcp --context …`), the server also serves
 * that step's flora-native tools; the extra fields carry what they need.
 */
export interface McpServerOptions {
  /** The step's $FLORA_CONTEXT file. Enables read_context. */
  context?: string
  /** The step's working directory; workflow paths resolve against it. */
  cwd?: string
  /** The run the step belongs to — nested runs record it as their parent. */
  runId?: string
  /** Depth a nested run would have (the step's run + 1). */
  depth?: number
  /** Workflow files of the runs above, for cycle detection. */
  stack?: string[]
  /** Workflows the step's contract lets the agent run. Enables call_workflow. */
  allowWorkflows?: string[]
}

/** Paths compared the way the file system does: case-insensitive on Windows. */
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

export interface ValidationReport {
  ok: boolean
  errors: ContractError[]
}

/**
 * Validate a workflow given as YAML text: syntax, then the JSON Schema, then
 * the code validator (which knows a few things the schema cannot say, such
 * as duplicate step ids). Errors carry a path so an agent can fix the exact
 * field instead of guessing.
 */
export function validateYaml(yaml: string): ValidationReport {
  let spec: unknown
  try {
    spec = parseYaml(yaml)
  } catch (err) {
    return { ok: false, errors: [{ path: '', message: `YAML: ${(err as Error).message}` }] }
  }

  const errors = schemaErrors(spec)
  try {
    validateWorkflow(spec as WorkflowSpec)
  } catch (err) {
    const message = err instanceof WorkflowError ? err.message : `invalid workflow: ${(err as Error).message}`
    if (!errors.some((e) => e.message === message)) errors.push({ path: pathFromMessage(message, spec), message })
  }
  return { ok: errors.length === 0, errors }
}

/** `step review: …` → `steps[1]`, so code-validator errors point somewhere too. */
function pathFromMessage(message: string, spec: unknown): string {
  const steps = (spec as { steps?: Array<{ id?: unknown }> } | null)?.steps
  if (!Array.isArray(steps)) return ''
  const duplicate = /^duplicate step id: (.+)$/.exec(message)
  if (duplicate) {
    // The offender is the later occurrence.
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i]?.id === duplicate[1]) return `steps[${i}]`
  }
  // `step solve[1]: …` points at a branch of step `solve`; the step is what we can address.
  const match = /^step ([^:[]+)(?:\[\d+\])?:/.exec(message)
  if (!match) return message.startsWith('param ') ? 'params' : ''
  const index = steps.findIndex((step) => step?.id === match[1])
  return index >= 0 ? `steps[${index}]` : 'steps'
}

/** What an agent gets back from run_workflow: the verdicts, not the transcript. */
export function summarizeRun(record: RunRecord): Record<string, unknown> {
  return {
    runId: record.runId,
    workflow: record.workflow,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    steps: record.steps.map((step) => ({
      id: step.stepId,
      status: step.status,
      attempt: step.attempt,
      harness: step.harness,
      exitCode: step.evidence?.exitCode,
      ...(step.output !== undefined ? { output: step.output } : {}),
      ...(step.outputError ? { outputError: step.outputError } : {}),
      checks: step.checks.map((check) => ({ passed: check.passed, detail: check.detail }))
    }))
  }
}

const json = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {})
})

/**
 * The MCP facade: an agent authoring a workflow validates it, reads the
 * contract, runs it and inspects the result — all through tools, never by
 * guessing the YAML dialect. Runs go through the same engine + recorder as
 * `flora run`, so the viewer shows them live.
 */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer(MCP_SERVER_INFO)
  if (options.context) {
    registerStepTools(server, options)
    return server
  }
  server.registerTool(
    'validate_workflow',
    {
      title: 'Validate a workflow',
      description:
        'Check a flora workflow given as YAML text. Returns { ok, errors: [{ path, message }] }; each path points at the field to fix (e.g. steps[1].output.type).',
      inputSchema: { yaml: z.string().describe('The workflow file contents, as YAML text') }
    },
    async ({ yaml }) => {
      const report = validateYaml(yaml)
      return json(report, !report.ok)
    }
  )

  server.registerTool(
    'describe_contract',
    {
      title: 'Describe the workflow contract',
      description:
        'Every field a flora workflow can have — types, which are required, and what they mean. Read this before writing a workflow.'
    },
    async () => ({ content: [{ type: 'text' as const, text: describeContract() }] })
  )

  server.registerTool(
    'run_workflow',
    {
      title: 'Run a workflow',
      description:
        'Run a workflow file through flora and wait for it. `path` is resolved against the working directory the MCP server was started in (or `cwd` when given); `cwd` is where the steps execute. Returns the verdict per step: status, checks, output — not the transcript.',
      inputSchema: {
        path: z.string().describe('Path to the workflow YAML'),
        params: z.record(z.string(), z.string()).optional().describe('Workflow params, name → value'),
        cwd: z.string().optional().describe('Directory the steps run in; defaults to the server working directory')
      }
    },
    async ({ path, params, cwd }) => {
      const runCwd = resolve(options.cwd ?? process.cwd(), cwd ?? '.')
      const workflowPath = isAbsolute(path) ? path : resolve(runCwd, path)
      let spec: WorkflowSpec
      try {
        spec = loadWorkflow(workflowPath)
      } catch (err) {
        return json({ error: (err as Error).message }, true)
      }
      const store = new RunStore()
      try {
        const recorder = createRecorder(store, { cwd: runCwd, params: params ?? {} })
        let record: RunRecord
        try {
          record = await runWorkflow(spec, { cwd: runCwd, params, source: workflowPath, onEvent: (event) => recorder.write(event) })
        } catch (err) {
          return json({ error: (err as Error).message }, true)
        } finally {
          recorder.close()
        }
        store.save(record)
        return json(summarizeRun(record))
      } finally {
        store.close()
      }
    }
  )

  server.registerTool(
    'get_run',
    {
      title: 'Get a run',
      description: 'The full journal record of one run: every step, its evidence, checks and output.',
      inputSchema: { runId: z.string().describe('Run id, as returned by run_workflow or list_runs') }
    },
    async ({ runId }) => {
      const store = new RunStore()
      try {
        const record = store.load(runId)
        return record ? json(record) : json({ error: 'no such run' }, true)
      } finally {
        store.close()
      }
    }
  )

  server.registerTool(
    'list_runs',
    {
      title: 'List recent runs',
      description: 'Recent runs from the journal, newest first — the same view as `flora runs --json`.',
      inputSchema: {
        workflow: z.string().optional().describe('Only runs of this workflow'),
        limit: z.number().int().min(1).max(200).optional().describe('At most this many (default 20)')
      }
    },
    async ({ workflow, limit }) => {
      const store = new RunStore()
      try {
        const runs = store.list(workflow ? 200 : (limit ?? 20)).filter((run) => !workflow || run.workflow === workflow)
        return json(runs.slice(0, limit ?? 20))
      } finally {
        store.close()
      }
    }
  )

  return server
}

/**
 * The tools a step's contract can mount from flora itself. Both read only
 * what the run already knows; call_workflow starts a nested run through the
 * same engine and recorder, so it shows up in the journal and the viewer
 * with a parentRunId — and it refuses cycles and runaway nesting.
 */
function registerStepTools(server: McpServer, options: McpServerOptions): void {
  const contextPath = options.context!
  const cwd = resolve(options.cwd ?? process.cwd())

  server.registerTool(
    'read_context',
    {
      title: 'Read the run context',
      description:
        'Read a value from this run: params.<name>, or steps.<id>.output followed by a path such as .items[0].id. Returns { path, value }.',
      inputSchema: { path: z.string().describe('Dot path with [index] segments, e.g. steps.fetch.output.items[0].id') }
    },
    async ({ path }) => {
      let context: RunContext
      try {
        context = JSON.parse(readFileSync(contextPath, 'utf8')) as RunContext
      } catch (err) {
        return json({ error: `cannot read the run context: ${(err as Error).message}` }, true)
      }
      const value = lookup(context, path)
      return value === undefined ? json({ error: `nothing at "${path}"` }, true) : json({ path, value })
    }
  )

  const allowed = (options.allowWorkflows ?? []).map((p) => resolve(cwd, p))
  if (!allowed.length) return

  server.registerTool(
    'call_workflow',
    {
      title: 'Run another workflow',
      description: `Run one of the workflows this step is allowed to call (${allowed.join(', ')}) and wait for its verdict. Returns status and per-step results, not the transcript.`,
      inputSchema: {
        workflow: z.string().optional().describe('Workflow path; defaults to the first allowed one'),
        params: z.record(z.string(), z.string()).optional().describe('Params for the nested run'),
        cwd: z.string().optional().describe('Directory the nested run works in; defaults to this step\'s')
      }
    },
    async ({ workflow, params, cwd: nestedCwd }) => {
      const target = resolve(cwd, workflow ?? allowed[0])
      if (!allowed.some((p) => samePath(p, target))) {
        return json({ error: `workflow is not allowed for this step: ${target}`, allowed }, true)
      }
      const depth = options.depth ?? 1
      const limit = maxDepth()
      if (depth > limit) {
        return json({ error: `nesting too deep: this run would be at depth ${depth}, FLORA_MAX_DEPTH is ${limit}` }, true)
      }
      const stack = options.stack ?? []
      if (stack.some((p) => samePath(p, target))) {
        return json({ error: `cycle: ${target} is already running higher up the call stack`, stack }, true)
      }

      let spec: WorkflowSpec
      try {
        spec = loadWorkflow(target)
      } catch (err) {
        return json({ error: (err as Error).message }, true)
      }
      const runCwd = resolve(cwd, nestedCwd ?? '.')
      const store = new RunStore()
      try {
        const recorder = createRecorder(store, { cwd: runCwd, params: params ?? {} })
        let record: RunRecord
        try {
          record = await runWorkflow(spec, {
            cwd: runCwd,
            params,
            source: target,
            depth,
            stack,
            parentRunId: options.runId,
            onEvent: (event) => recorder.write(event)
          })
        } catch (err) {
          return json({ error: (err as Error).message }, true)
        } finally {
          recorder.close()
        }
        store.save(record)
        return json(summarizeRun(record))
      } finally {
        store.close()
      }
    }
  )
}

/** `flora mcp`: speak MCP over stdio until the client hangs up. */
export async function serveMcp(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise<void>((done) => {
    const onclose = server.server.onclose
    server.server.onclose = () => { onclose?.(); done() }
  })
}
