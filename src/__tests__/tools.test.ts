import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeArgs } from '../adapters/claude-code'
import { codexArgs } from '../adapters/codex'
import { schemaErrors } from '../contract'
import { RunStore } from '../state'
import { claudeMcpConfig, codexMcpArgs, FLORA_BIN, mcpServersFor, type McpServerEntry } from '../tools'
import { validateWorkflow, WorkflowError } from '../workflow'
import type { RunRecord, StepSpec, ToolSpec, WorkflowSpec } from '../types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-tools-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const agentStep = (tools: unknown, harness = 'claude-code'): WorkflowSpec => ({
  name: 'tools',
  steps: [{ id: 'a', executor: { harness }, prompt: 'go', tools } as StepSpec]
})

const dbTool: ToolSpec = { mcp: { name: 'db', command: 'npx', args: ['-y', 'server-postgres', '{{db_url}}'], env: { PGSSLMODE: 'require' } } }
const callTool: ToolSpec = { flora: 'call_workflow', workflow: './review.yaml' }
const readTool: ToolSpec = { flora: 'read_context' }

describe('tools contract', () => {
  it('accepts external servers and the flora-native tools on an agent step', () => {
    const spec = agentStep([dbTool, callTool, readTool])
    expect(() => validateWorkflow(spec)).not.toThrow()
    expect(schemaErrors(spec)).toEqual([])
  })

  it('refuses tools on harnesses without an MCP client, in code and in the schema', () => {
    for (const harness of ['command', 'harmonia']) {
      const spec = agentStep([readTool], harness)
      if (harness === 'command') spec.steps[0].run = 'x'
      expect(() => validateWorkflow(spec)).toThrow(/cannot mount tools/)
      expect(schemaErrors(spec).length).toBeGreaterThan(0)
    }
  })

  it.each([
    ['both kinds at once', [{ mcp: { name: 'a', command: 'x' }, flora: 'read_context' }], /either/],
    ['no command', [{ mcp: { name: 'a' } }], /command is required/],
    ['bad server name', [{ mcp: { name: 'my server', command: 'x' } }], /plain identifier/],
    ['reserved name', [{ mcp: { name: 'flora', command: 'x' } }], /taken/],
    ['steps.* in args', [{ mcp: { name: 'a', command: 'x', args: ['{{steps.b.output}}'] } }], /not allowed in tool/],
    ['steps.* in env', [{ mcp: { name: 'a', command: 'x', env: { K: '{{ steps.b.output }}' } } }], /not allowed in tool/],
    ['unknown mcp field', [{ mcp: { name: 'a', command: 'x', cwd: '/' } }], /unknown field "cwd"/],
    ['call_workflow without workflow', [{ flora: 'call_workflow' }], /needs "workflow"/],
    ['unknown flora tool', [{ flora: 'delete_everything' }], /unknown flora tool/],
    ['not a list', { mcp: {} }, /must be a list/]
  ])('refuses %s', (_name, tools, message) => {
    const spec = agentStep(tools)
    expect(() => validateWorkflow(spec)).toThrow(message)
    expect(() => validateWorkflow(spec)).toThrow(WorkflowError)
    expect(schemaErrors(spec).length).toBeGreaterThan(0)
  })

  it('refuses two servers with the same name (code only — a schema cannot see across items)', () => {
    const spec = agentStep([{ mcp: { name: 'a', command: 'x' } }, { mcp: { name: 'a', command: 'y' } }])
    expect(() => validateWorkflow(spec)).toThrow(/taken/)
  })
})

describe('MCP servers for a step', () => {
  const context = {
    params: { db_url: 'postgresql://localhost/app' },
    contextPath: '/tmp/ctx.json',
    cwd: '/work/repo',
    runId: 'run-1',
    depth: 0,
    stack: ['/work/repo/main.yaml']
  }

  it('passes external servers through with params substituted', () => {
    const [db] = mcpServersFor([dbTool], context)
    expect(db).toEqual({
      name: 'db',
      command: 'npx',
      args: ['-y', 'server-postgres', 'postgresql://localhost/app'],
      env: { PGSSLMODE: 'require' }
    })
  })

  it('turns the flora-native tools into one flora mcp server with the step on the command line', () => {
    const servers = mcpServersFor([dbTool, callTool, readTool], context)
    expect(servers.map((s) => s.name)).toEqual(['db', 'flora'])
    const flora = servers[1]
    expect(flora.command).toBe(process.execPath)
    expect(flora.args[0]).toBe(FLORA_BIN)
    expect(flora.args[1]).toBe('mcp')
    const flag = (name: string): string => flora.args[flora.args.indexOf(name) + 1]
    expect(flag('--context')).toBe('/tmp/ctx.json')
    expect(flag('--cwd')).toBe('/work/repo')
    expect(flag('--run')).toBe('run-1')
    expect(flag('--depth')).toBe('1')
    expect(flag('--stack')).toBe('/work/repo/main.yaml')
    expect(flag('--allow-workflow')).toBe(resolve('/work/repo', './review.yaml'))
  })

  it('nothing to mount means no servers', () => {
    expect(mcpServersFor(undefined, context)).toEqual([])
    expect(mcpServersFor([], context)).toEqual([])
  })
})

describe('harness command lines', () => {
  const servers: McpServerEntry[] = [
    { name: 'db', command: 'npx', args: ['-y', 'x'], env: { PGSSLMODE: 'require' } },
    { name: 'flora', command: 'node', args: ['/f/bin/flora.mjs', 'mcp'], env: {} }
  ]
  const input = { spec: { harness: 'claude-code' }, prompt: 'do it', cwd: '/w', mcp: servers }

  it('claude-code: strict mcp config file plus pre-approved server tools', () => {
    const args = claudeArgs(input, '/tmp/mcp.json')
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', '/tmp/mcp.json', '--strict-mcp-config']))
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__db,mcp__flora')
    expect(claudeArgs({ ...input, mcp: [] })).not.toContain('--mcp-config')

    const config = JSON.parse(claudeMcpConfig(servers)) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(config.mcpServers.db).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { PGSSLMODE: 'require' } })
    expect(config.mcpServers.flora.env).toBeUndefined()
  })

  it('codex: one inline config override per server', () => {
    const args = codexArgs({ ...input, spec: { harness: 'codex' } })
    expect(codexMcpArgs(servers)).toEqual([
      '-c',
      'mcp_servers.db={command="npx",args=["-y","x"],env={PGSSLMODE="require"}}',
      '-c',
      'mcp_servers.flora={command="node",args=["/f/bin/flora.mjs","mcp"]}'
    ])
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args).toContain('mcp_servers.db={command="npx",args=["-y","x"],env={PGSSLMODE="require"}}')
    expect(args[args.length - 1]).toBe('do it')
  })
})

describe('engine hands the step its servers', () => {
  it('passes mcp entries whose --context file exists while the step runs', async () => {
    let seen: McpServerEntry[] | undefined
    let contextExisted = false
    vi.doMock('../adapters/index', () => ({
      adapterFor: () => ({
        name: 'fake',
        execute: async (input: { mcp?: McpServerEntry[] }) => {
          seen = input.mcp
          const ctx = input.mcp?.find((s) => s.name === 'flora')?.args
          const path = ctx ? ctx[ctx.indexOf('--context') + 1] : ''
          contextExisted = existsSync(path)
          return { output: 'ok', exitCode: 0, durationMs: 1 }
        }
      })
    }))
    const { runWorkflow } = await import('../engine')
    const record = await runWorkflow(agentStep([dbTool, callTool]), { cwd: dir, params: { db_url: 'pg://x' }, source: join(dir, 'main.yaml') })
    expect(record.status).toBe('passed')
    expect(seen?.map((s) => s.name)).toEqual(['db', 'flora'])
    expect(seen?.[0].args).toContain('pg://x')
    expect(contextExisted).toBe(true)
    vi.doUnmock('../adapters/index')
  })
})

describe('flora mcp as a step tool (stdio)', () => {
  const examples = join(process.cwd(), 'examples')
  const hello = join(examples, 'hello.yaml')

  const connect = async (extra: string[]): Promise<Client> => {
    const client = new Client({ name: 'flora-tools-test', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['bin/flora.mjs', 'mcp', ...extra],
        env: { ...(process.env as Record<string, string>), FLORA_DB: join(dir, 'flora.db') },
        stderr: 'pipe'
      })
    )
    return client
  }

  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean }
    return { isError: Boolean(result.isError), body: JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? 'null') as Record<string, unknown> }
  }

  it('serves read_context and call_workflow, records the nested run under its parent, and refuses what the contract did not allow', async () => {
    const contextPath = join(dir, 'context.json')
    writeFileSync(contextPath, JSON.stringify({ params: { who: 'me' }, steps: { fetch: { output: { items: [{ id: 7 }] } } } }))
    const client = await connect(['--context', contextPath, '--cwd', dir, '--run', 'parent-run', '--depth', '1', '--stack', join(dir, 'main.yaml'), '--allow-workflow', hello])
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(['call_workflow', 'read_context'])
      expect((await client.callTool({ name: 'run_workflow', arguments: { path: hello } })).isError).toBe(true)

      expect(await call(client, 'read_context', { path: 'steps.fetch.output.items[0].id' })).toEqual({ isError: false, body: { path: 'steps.fetch.output.items[0].id', value: 7 } })
      expect(await call(client, 'read_context', { path: 'who' })).toEqual({ isError: false, body: { path: 'who', value: 'me' } })
      expect((await call(client, 'read_context', { path: 'steps.nope.output' })).isError).toBe(true)

      const nested = await call(client, 'call_workflow', { params: { message: 'from the parent' } })
      expect(nested.isError).toBe(false)
      expect(nested.body.status).toBe('passed')
      expect(readFileSync(join(dir, 'greeting.txt'), 'utf8')).toContain('from the parent')

      const store = new RunStore(join(dir, 'flora.db'))
      const record = store.load(String(nested.body.runId)) as RunRecord
      store.close()
      expect(record.parentRunId).toBe('parent-run')

      const forbidden = await call(client, 'call_workflow', { workflow: join(examples, 'data-pipeline.yaml') })
      expect(forbidden.isError).toBe(true)
      expect(String(forbidden.body.error)).toContain('not allowed')
    } finally {
      await client.close()
    }
  }, 60_000)

  it('refuses to nest past FLORA_MAX_DEPTH and to re-enter a workflow already on the stack', async () => {
    const contextPath = join(dir, 'context.json')
    writeFileSync(contextPath, JSON.stringify({ params: {}, steps: {} }))

    const deep = await connect(['--context', contextPath, '--cwd', dir, '--depth', '4', '--allow-workflow', hello])
    try {
      const result = await call(deep, 'call_workflow', {})
      expect(result.isError).toBe(true)
      expect(String(result.body.error)).toMatch(/too deep/)
    } finally {
      await deep.close()
    }

    const cyclic = await connect(['--context', contextPath, '--cwd', dir, '--depth', '2', '--stack', [join(dir, 'root.yaml'), hello].join(delimiter), '--allow-workflow', hello])
    try {
      const result = await call(cyclic, 'call_workflow', { workflow: hello })
      expect(result.isError).toBe(true)
      expect(String(result.body.error)).toMatch(/cycle/)
    } finally {
      await cyclic.close()
    }
  }, 60_000)

  it('a bare flora mcp has no step tools', async () => {
    const client = await connect([])
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).not.toContain('read_context')
      expect(tools.map((t) => t.name)).not.toContain('call_workflow')
    } finally {
      await client.close()
    }
  }, 40_000)
})
