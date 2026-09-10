import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachUsage, parseUsage } from '../adapters/usage'
import { RunStore } from '../state'
import { formatUsageTable, runUsage, usageOfStep } from '../usage'
import type { RunRecord, StepResult } from '../types'

const run = promisify(execFile)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-usage-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const flora = (args: string[]) =>
  run(process.execPath, ['bin/flora.mjs', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, FLORA_DB: join(dir, 'flora.db') }
  })

const step = (over: Partial<StepResult>): StepResult => ({ stepId: 's', attempt: 1, status: 'passed', checks: [], ...over })

describe('usage parser: calls and money', () => {
  it('reads calls and cost from inside a usage object (a script fanning out over an API)', () => {
    expect(parseUsage('{"stage":"02","ok":100,"usage":{"calls":3,"input_tokens":1000,"output_tokens":200,"cost_usd":1.25}}')).toEqual({
      calls: 3,
      inputTokens: 1000,
      outputTokens: 200,
      contextTokens: 1000,
      totalTokens: 1200,
      costUsd: 1.25
    })
  })

  it('takes Claude Code’s price from next to the usage object', () => {
    expect(
      parseUsage('{"type":"result","total_cost_usd":0.0412,"usage":{"input_tokens":1200,"output_tokens":340,"cache_read_input_tokens":8000}}')
    ).toMatchObject({ inputTokens: 1200, outputTokens: 340, cachedTokens: 8000, contextTokens: 9200, totalTokens: 9540, costUsd: 0.0412 })
  })

  it('reads a text summary with a price', () => {
    expect(parseUsage('done\n\ntokens used: 12,345 · 3 calls · cost: $0.42\n')).toEqual({ totalTokens: 12345, calls: 3, costUsd: 0.42 })
  })

  it('attachUsage keeps a price the adapter already knew', () => {
    const evidence = attachUsage({ output: '{"usage":{"input_tokens":10,"output_tokens":5,"cost":0.5}}', exitCode: 0, durationMs: 1, costUsd: 0.25 })
    expect(evidence.costUsd).toBe(0.25)
    expect(evidence.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.5 })
    expect(attachUsage({ output: 'nothing here', exitCode: 0, durationMs: 1 }).usage).toBeUndefined()
  })
})

describe('run usage', () => {
  it('counts every attempt and every branch, and leaves unreported steps blank', () => {
    const record: RunRecord = {
      runId: 'r1',
      workflow: 'demo',
      cwd: '/tmp',
      params: {},
      status: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      steps: [
        step({
          stepId: 'implement',
          attempt: 2,
          evidence: { output: '', exitCode: 0, durationMs: 10, costUsd: 0.3, usage: { inputTokens: 1000, outputTokens: 200 } },
          priorAttempts: [{ attempt: 1, status: 'failed', evidence: { durationMs: 5, exitCode: 1, costUsd: 0.1, usage: { inputTokens: 400, outputTokens: 50, totalTokens: 450 } } }]
        }),
        step({
          stepId: 'review',
          harness: 'parallel',
          branches: [
            step({ stepId: 'review#0', evidence: { output: '', exitCode: 0, durationMs: 1, usage: { inputTokens: 10, outputTokens: 1, calls: 1 } } }),
            step({ stepId: 'review#1', status: 'failed', evidence: { output: '', exitCode: 1, durationMs: 1, usage: { inputTokens: 20, outputTokens: 2, calls: 1, costUsd: 0.02 } } })
          ]
        }),
        step({ stepId: 'lint', harness: 'command', evidence: { output: 'ok', exitCode: 0, durationMs: 1 } }),
        step({ stepId: 'deploy', status: 'skipped', attempt: 0 })
      ]
    }
    const usage = runUsage(record)
    expect(usage.steps.map((s) => [s.stepId, s.attempts, s.inputTokens, s.outputTokens, s.totalTokens, s.costUsd, s.reported])).toEqual([
      ['implement', 2, 1400, 250, 1650, 0.4, true],
      ['review', 1, 30, 3, 33, 0.02, true],
      ['lint', 1, undefined, undefined, undefined, undefined, false],
      ['deploy', 0, undefined, undefined, undefined, undefined, false]
    ])
    expect(usage.steps[1].calls).toBe(2)
    expect(usage.total).toMatchObject({ attempts: 4, calls: 2, inputTokens: 1430, outputTokens: 253, totalTokens: 1683, costUsd: 0.42, reported: true })

    const table = formatUsageTable(usage)
    expect(table).toContain('implement')
    expect(table).toMatch(/lint\s+1\s+–\s+–\s+–\s+–\s+–/)
    expect(table).not.toContain('deploy')
    expect(table).toMatch(/total\s+4\s+2\s+1,430\s+253\s+1,683\s+\$0\.42/)
  })

  it('a step with nothing to report is not zero', () => {
    expect(usageOfStep(step({ stepId: 'x' })).reported).toBe(false)
  })
})

describe('flora usage', () => {
  it('a command step that prints its spend is counted, and the CLI shows the table', { timeout: 90_000 }, async () => {
    const script = join(dir, 'spend.mjs')
    writeFileSync(
      script,
      `console.error('working…')
console.log(JSON.stringify({ ok: true, usage: { calls: 3, input_tokens: 1200, output_tokens: 300, cost_usd: 0.05 } }))`
    )
    const workflow = join(dir, 'spend.yaml')
    writeFileSync(
      workflow,
      `name: spend
steps:
  - id: fanout
    executor: { harness: command }
    run: node "${script.replace(/\\/g, '/')}"
    output: { type: json, schema: { type: object, required: [ok] } }
  - id: free
    executor: { harness: command }
    run: node -e "console.log('nothing to report')"
`
    )
    const { stdout: runOut } = await flora(['run', workflow, '--cwd', dir])
    expect(runOut).toContain('run passed')

    const { stdout } = await flora(['usage'])
    expect(stdout).toContain('spend')
    expect(stdout).toMatch(/fanout\s+1\s+3\s+1,200\s+300\s+1,500\s+\$0\.0500/)
    expect(stdout).toMatch(/free\s+1\s+–/)
    expect(stdout).toMatch(/total\s+2\s+3\s+1,200\s+300\s+1,500\s+\$0\.0500/)

    const { stdout: json } = await flora(['usage', 'latest', '--json'])
    const parsed = JSON.parse(json) as { total: { calls: number; costUsd: number }; steps: Array<{ stepId: string; reported: boolean }> }
    expect(parsed.total).toMatchObject({ calls: 3, costUsd: 0.05 })
    expect(parsed.steps.find((s) => s.stepId === 'free')?.reported).toBe(false)

    const { stdout: all } = await flora(['usage', '--all'])
    expect(all).toContain('1,500 tokens')
    expect(all).toContain('$0.0500')
  })

  it('says so when nothing was reported, and names an unknown run', { timeout: 60_000 }, async () => {
    const store = new RunStore(join(dir, 'flora.db'))
    store.save({
      runId: 'quiet-run',
      workflow: 'quiet',
      cwd: dir,
      params: {},
      status: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      steps: [step({ stepId: 'only', harness: 'command', evidence: { output: 'hi', exitCode: 0, durationMs: 1 } })]
    })
    store.close()
    const { stdout } = await flora(['usage', 'quiet-run'])
    expect(stdout).toContain('no step reported usage')
    await expect(flora(['usage', 'no-such-run'])).rejects.toMatchObject({ stderr: expect.stringContaining('no run "no-such-run"') })
  })
})
