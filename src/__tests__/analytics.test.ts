import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyticsRows, formatAnalyticsTable, mermaidFlow, runAnalytics, toCsv } from '../analytics'
import { inputsOf } from '../engine'
import { renderRunReport } from '../report'
import type { RunRecord, StepSpec } from '../types'

const run = promisify(execFile)
const BIN = join(process.cwd(), 'bin', 'flora.mjs')
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-analytics-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const record: RunRecord = {
  runId: 'an-1',
  workflow: 'pipeline',
  cwd: '/w',
  params: {},
  status: 'passed',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:10:00.000Z',
  steps: [
    { stepId: 'ingest', attempt: 1, status: 'passed', checks: [], evidence: { output: '', exitCode: 0, durationMs: 1000 }, output: { posts: 200, metrics: { in: 2400, out: 200 } }, metrics: { in: 2400, out: 200 }, outputBytes: 40 },
    {
      stepId: 'filter',
      attempt: 1,
      status: 'passed',
      harness: 'command',
      checks: [],
      inputsFrom: ['ingest'],
      evidence: { output: '', exitCode: 0, durationMs: 60_000, usage: { inputTokens: 1_000, outputTokens: 200, calls: 3, costUsd: 1.25 } },
      metrics: { in: 100, out: 80, rejected: 20 },
      outputBytes: 120
    },
    { stepId: 'report', attempt: 1, status: 'passed', harness: 'command', checks: [], inputsFrom: ['filter', 'ingest'], evidence: { output: '', exitCode: 0, durationMs: 500 }, outputBytes: 10 },
    { stepId: 'deploy', attempt: 0, status: 'skipped', checks: [], inputsFrom: ['report'] }
  ]
}

describe('inputsOf', () => {
  it('collects needs and every {{steps.<id>…}} reference across the step, its checks and branches', () => {
    const step: StepSpec = {
      id: 'c',
      needs: ['a'],
      when: '{{steps.a.status}} == passed',
      executor: { harness: 'command' },
      run: 'node x.mjs {{steps.b.output.path}} {{ steps.b.output.n }}',
      verify: [{ type: 'command', run: 'test', expect_match: '{{steps.z.output.tag}}' }]
    }
    expect(inputsOf(step)).toEqual(['a', 'b', 'z'])
    expect(inputsOf({ id: 'p', parallel: { branches: [{ executor: { harness: 'command' }, run: 'echo {{steps.q.output}}' }] } } as StepSpec)).toEqual(['q'])
    expect(inputsOf({ id: 'self', executor: { harness: 'command' }, run: 'echo {{steps.self.output}}' })).toEqual([])
  })
})

describe('run analytics', () => {
  it('lays in → out, time, tokens, money and size side by side, with the flow edges', () => {
    const a = runAnalytics(record)
    expect(a.steps.map((s) => [s.stepId, s.in, s.out, s.costUsd, s.outputBytes])).toEqual([
      ['ingest', 2400, 200, undefined, 40],
      ['filter', 100, 80, 1.25, 120],
      ['report', undefined, undefined, undefined, 10],
      ['deploy', undefined, undefined, undefined, undefined]
    ])
    expect(a.edges).toEqual([
      { from: 'ingest', to: 'filter' },
      { from: 'filter', to: 'report' },
      { from: 'ingest', to: 'report' },
      { from: 'report', to: 'deploy' }
    ])
    expect(a.totals).toMatchObject({ steps: 3, durationMs: 600_000, calls: 3, totalTokens: 1_200, costUsd: 1.25, outputBytes: 170 })

    const table = formatAnalyticsTable(a)
    expect(table).toMatch(/filter\s+ingest\s+100 → 80\s+1m00s\s+3\s+1,200\s+\$1\.25\s+120 B/)
    expect(table).toMatch(/report\s+filter,ingest\s+–/)
    expect(table).not.toContain('deploy')
    expect(table).toContain('rejected=20')

    const mermaid = mermaidFlow(a)
    expect(mermaid).toContain('flowchart LR')
    expect(mermaid).toContain('filter["filter<br/>100 → 80<br/>$1.25"]')
    expect(mermaid).toContain('ingest --> filter')
    expect(mermaid).toContain('deploy(["deploy"])')

    const report = renderRunReport(record)
    expect(report).toContain('## Analytics')
    expect(report).toContain('| filter | ingest | 100 → 80 | 1m00s | 3 | 1,200 | $1.25 | 120 B |')
    expect(report).toContain('```mermaid')
  })

  it('CSV: one row per step per run, Excel-friendly', () => {
    const rows = analyticsRows([record])
    expect(rows.map((r) => r.step)).toEqual(['ingest', 'filter', 'report', 'deploy'])
    expect(rows[1]).toMatchObject({ run_id: 'an-1', from: 'ingest', in: 100, out: 80, metrics: '{"rejected":20}', calls: 3, cost_usd: 1.25, output_bytes: 120 })
    const csv = toCsv(rows)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('run_id,workflow,run_status,started_at,step,title,step_status,harness,from,in,out,metrics,attempts,duration_ms,calls,input_tokens,output_tokens,total_tokens,cost_usd,output_bytes')
    expect(csv).toContain('an-1,pipeline,passed,2026-01-01T00:00:00.000Z,filter,,passed,command,ingest,100,80,"{""rejected"":20}",1,60000,3,1000,200,1200,1.25,120')
  })
})

describe('flora analytics', () => {
  it('a real run records metrics, sizes and the flow; the CLI shows and exports them', { timeout: 120_000 }, async () => {
    const home = join(dir, 'home')
    mkdirSync(home)
    const script = join(dir, 'stage.mjs')
    writeFileSync(
      script,
      `const [stage, n] = process.argv.slice(2)
const out = Math.round(Number(n) * 0.75)
console.log(JSON.stringify({ stage, ok: true, metrics: { in: Number(n), out, dropped: Number(n) - out }, usage: { calls: 2, input_tokens: 1000, output_tokens: 100, cost_usd: 0.01 } }))`
    )
    const workflow = join(dir, 'flow.yaml')
    writeFileSync(
      workflow,
      `name: flow
steps:
  - id: a
    executor: { harness: command }
    run: node "${script.replace(/\\/g, '/')}" a 200
    output: { type: json, schema: { type: object, required: [ok] } }
  - id: b
    needs: [a]
    executor: { harness: command }
    run: node "${script.replace(/\\/g, '/')}" b {{steps.a.output.metrics.out}}
    output: { type: json, schema: { type: object, required: [ok] } }
`
    )
    const flora = (args: string[]) =>
      run(process.execPath, [BIN, ...args], { cwd: dir, env: { ...process.env, FLORA_HOME: home, FLORA_DB: join(home, 'flora.db') } }).then((r) => ({ ...r, stdout: plain(r.stdout) }))
    // {{steps.a.output…}} in run: is only allowed in prompts per the contract; the flow edge comes from needs.
    writeFileSync(workflow, readFileSync(workflow, 'utf8').replace('{{steps.a.output.metrics.out}}', '150'))
    const { stdout: ran } = await flora(['run', workflow, '--cwd', dir])
    expect(ran).toContain('run passed')

    const { stdout } = await flora(['analytics'])
    expect(stdout).toMatch(/a\s+–\s+200 → 150/)
    expect(stdout).toMatch(/b\s+a\s+150 → 113/)
    expect(stdout).toContain('dropped=50')
    expect(stdout).toContain('flow: a → b')

    const { stdout: json } = await flora(['analytics', 'latest', '--json'])
    const parsed = JSON.parse(json) as { steps: Array<{ stepId: string; inputsFrom: string[]; outputBytes: number }>; totals: { costUsd: number } }
    expect(parsed.steps[1]).toMatchObject({ stepId: 'b', inputsFrom: ['a'] })
    expect(parsed.steps[0].outputBytes).toBeGreaterThan(50)
    expect(parsed.totals.costUsd).toBe(0.02)

    const csv = join(dir, 'all.csv')
    const { stdout: exported } = await flora(['analytics', '--all', '--csv', csv])
    expect(exported).toContain('2 rows')
    expect(readFileSync(csv, 'utf8')).toContain('flow,passed')

    const { stdout: all } = await flora(['analytics', '--all'])
    expect(all).toMatch(/passed\s+flow\s+2/)
  })
})
