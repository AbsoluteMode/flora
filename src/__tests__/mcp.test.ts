import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { describeContract, schemaErrors } from '../contract'
import { summarizeRun, validateYaml } from '../mcp/server'
import { validateWorkflow, WorkflowError } from '../workflow'
import type { RunRecord, WorkflowSpec } from '../types'

const examplesDir = join(process.cwd(), 'examples')

const base = `name: demo\nsteps:\n  - id: a\n    executor: { harness: command }\n    run: echo hi\n`

/**
 * Invalid workflows both validators must refuse. `codeOnly` marks rules a
 * JSON Schema cannot express (uniqueness across items); everything else has
 * to be rejected by the schema too, or the two have drifted apart.
 */
const negatives: Array<{ name: string; yaml: string; codeOnly?: boolean }> = [
  { name: 'no name', yaml: 'steps:\n  - id: a\n    executor: { harness: command }\n    run: x\n' },
  { name: 'empty steps', yaml: 'name: x\nsteps: []\n' },
  { name: 'step without id', yaml: 'name: x\nsteps:\n  - executor: { harness: command }\n    run: x\n' },
  { name: 'duplicate step id', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x }\n  - { id: a, executor: { harness: command }, run: y }\n', codeOnly: true },
  { name: 'id that cannot be referenced', yaml: 'name: x\nsteps:\n  - { id: "my step", executor: { harness: command }, run: x }\n' },
  { name: 'unknown harness', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: gpt }, prompt: x }\n' },
  { name: 'command without run', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command } }\n' },
  { name: 'agent without prompt', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: codex } }\n' },
  { name: 'command check without run', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x, verify: [{ type: command }] }\n' },
  { name: 'artifact check without path', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x, verify: [{ type: artifact }] }\n' },
  { name: 'steps.* inside run', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: "echo {{steps.b.output}}" }\n' },
  { name: 'steps.* inside a check run', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x, verify: [{ type: command, run: "test {{ steps.a.output }}" }] }\n' },
  { name: 'unknown output type', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x, output: { type: xml } }\n' },
  { name: 'schema without json', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x, output: { schema: { type: object } } }\n' },
  { name: 'negative timeout', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command, timeout_min: -1 }, run: x }\n' },
  { name: 'negative retry', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x, on_fail: { retry: -1 } }\n' },
  { name: 'unknown top-level field', yaml: `${base}stepz: []\n` },
  { name: 'unknown step field (typo)', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x, verfy: [] }\n' },
  { name: 'unknown executor field', yaml: 'name: x\nsteps:\n  - { id: a, executor: { harness: command, timeout: 5 }, run: x }\n' },
  { name: 'param default that is not a string', yaml: 'name: x\nparams:\n  n: { default: 5 }\nsteps:\n  - { id: a, executor: { harness: command }, run: x }\n' }
]

describe('contract schema and code validator agree', () => {
  it('accepts every shipped example, the e2e stand included', () => {
    const files = readdirSync(examplesDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.yaml'))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const spec = parse(readFileSync(join(examplesDir, file), 'utf8')) as WorkflowSpec
      expect(schemaErrors(spec), file).toEqual([])
      expect(() => validateWorkflow(spec), file).not.toThrow()
    }
  })

  it.each(negatives)('both refuse: $name', ({ yaml, codeOnly }) => {
    const spec = parse(yaml) as WorkflowSpec
    expect(() => validateWorkflow(spec)).toThrow(WorkflowError)
    if (!codeOnly) expect(schemaErrors(spec).length).toBeGreaterThan(0)
  })

  it('describes every field, generated from the schema itself', () => {
    const text = describeContract()
    for (const field of ['name*', 'steps*', 'executor*', 'harness*', 'verify', 'output', 'on_fail', 'stall_min', 'expect_match', 'contains']) {
      expect(text).toContain(field)
    }
    expect(text).toContain('claude-code | codex | harmonia | command')
  })
})

describe('validate_workflow', () => {
  it('points at the broken field', () => {
    const report = validateYaml('name: x\nsteps:\n  - id: a\n    executor: { harness: command }\n    run: echo\n    output: { type: xml }\n')
    expect(report.ok).toBe(false)
    expect(report.errors).toContainEqual({ path: 'steps[0].output.type', message: 'must be one of: json, text' })
  })

  it('names unknown fields, refuses steps.* in run, and survives broken YAML', () => {
    expect(validateYaml(`${base}stepz: []\n`).errors).toContainEqual({ path: '', message: 'unknown field "stepz"' })
    const injected = validateYaml('name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: "echo {{steps.b.output}}" }\n')
    expect(injected.errors.some((e) => e.path === 'steps[0].run')).toBe(true)
    const broken = validateYaml('name: [unclosed\nsteps: {')
    expect(broken.ok).toBe(false)
    expect(broken.errors[0].message).toMatch(/^YAML:/)
  })

  it('gives code-only rules a path too', () => {
    const report = validateYaml('name: x\nsteps:\n  - { id: a, executor: { harness: command }, run: x }\n  - { id: a, executor: { harness: command }, run: y }\n')
    expect(report.errors).toContainEqual({ path: 'steps[1]', message: 'duplicate step id: a' })
  })

  it('passes a valid workflow', () => {
    expect(validateYaml(readFileSync(join(examplesDir, 'data-pipeline.yaml'), 'utf8'))).toEqual({ ok: true, errors: [] })
  })
})

describe('run summary', () => {
  it('keeps verdicts and outputs, drops transcripts', () => {
    const record: RunRecord = {
      runId: 'r',
      workflow: 'w',
      cwd: '/x',
      params: {},
      status: 'failed',
      startedAt: 't',
      steps: [
        {
          stepId: 's',
          harness: 'command',
          attempt: 2,
          status: 'failed',
          evidence: { output: 'a very long transcript', exitCode: 0, durationMs: 1 },
          checks: [{ check: { type: 'command', run: 'x' }, passed: false, detail: 'exit 1' }],
          outputError: 'output is not valid JSON'
        }
      ]
    }
    const summary = summarizeRun(record) as { steps: Array<Record<string, unknown>> }
    expect(summary.steps[0]).toEqual({
      id: 's',
      status: 'failed',
      attempt: 2,
      harness: 'command',
      exitCode: 0,
      outputError: 'output is not valid JSON',
      checks: [{ passed: false, detail: 'exit 1' }]
    })
    expect(JSON.stringify(summary)).not.toContain('transcript')
  })
})

describe('flora mcp over stdio', () => {
  let dir: string
  let client: Client

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'flora-mcp-'))
    client = new Client({ name: 'flora-test', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['bin/flora.mjs', 'mcp'],
        env: { ...(process.env as Record<string, string>), FLORA_DB: join(dir, 'flora.db') },
        stderr: 'pipe'
      })
    )
  }, 40_000)

  afterAll(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean }
    const text = result.content.find((c) => c.type === 'text')?.text ?? ''
    return name === 'describe_contract' ? text : JSON.parse(text)
  }

  it('offers the five authoring tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['describe_contract', 'get_run', 'list_runs', 'run_workflow', 'validate_workflow'])
  })

  it('validates, runs hello in a scratch dir, then finds the run in the journal', async () => {
    const yaml = readFileSync(join(examplesDir, 'hello.yaml'), 'utf8')
    expect(await call('validate_workflow', { yaml })).toEqual({ ok: true, errors: [] })

    const run = (await call('run_workflow', { path: join(examplesDir, 'hello.yaml'), cwd: dir, params: { message: 'via mcp' } })) as {
      runId: string
      status: string
      steps: Array<{ id: string; status: string }>
    }
    expect(run.status).toBe('passed')
    expect(run.steps.map((s) => s.id)).toEqual(['write-greeting'])
    expect(readFileSync(join(dir, 'greeting.txt'), 'utf8')).toContain('via mcp')

    const record = (await call('get_run', { runId: run.runId })) as RunRecord
    expect(record.workflow).toBe('hello')
    expect(record.params).toEqual({ message: 'via mcp' })

    const runs = (await call('list_runs', { workflow: 'hello' })) as Array<{ runId: string }>
    expect(runs.map((r) => r.runId)).toEqual([run.runId])
    expect(await call('list_runs', { workflow: 'nope' })).toEqual([])
  }, 60_000)

  it('reports a missing workflow as a tool error, not a crash', async () => {
    const result = (await client.callTool({ name: 'run_workflow', arguments: { path: join(dir, 'missing.yaml') } })) as { isError?: boolean }
    expect(result.isError).toBe(true)
    const missing = (await client.callTool({ name: 'get_run', arguments: { runId: 'nope' } })) as { isError?: boolean }
    expect(missing.isError).toBe(true)
  })

  it('describes the contract as text', async () => {
    expect(await call('describe_contract')).toContain('workflow')
  })
})
