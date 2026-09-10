import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { packWorkflow } from '../bundle'
import { analyticsRows, mermaidFlow, runAnalytics, toCsv } from '../analytics'
import { renderRunReport } from '../report'
import type { RunRecord } from '../types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flora-share-audit-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
const record = (): RunRecord => ({ runId: 'safe-run', workflow: 'demo', status: 'passed', cwd: dir, params: {}, startedAt: new Date().toISOString(), steps: [{ stepId: 'work', attempt: 1, status: 'passed', checks: [] }] })

it('leaves common credential files out of a shareable bundle by default', () => {
  const file = join(dir, 'workflow.yaml')
  writeFileSync(file, 'name: safe\nsteps:\n  - id: s\n    executor: { harness: command }\n    run: echo ok\n')
  for (const name of ['.env', '.env.local', '.npmrc', '.netrc']) writeFileSync(join(dir, name), 'fake-secret-for-test')
  const bundle = packWorkflow(file)
  expect(bundle.manifest.files.map((f) => f.path)).toEqual(['workflow.yaml'])
})

it('applies ** exclusions through multiple directory levels', () => {
  const file = join(dir, 'workflow.yaml')
  writeFileSync(file, 'name: safe\nsteps:\n  - id: s\n    executor: { harness: command }\n    run: echo ok\n')
  mkdirSync(join(dir, 'a/b/c'), { recursive: true })
  writeFileSync(join(dir, 'a/b/c/private.secret'), 'fake-secret')
  const bundle = packWorkflow(file, { exclude: ['**/*.secret'] })
  expect(bundle.manifest.files.map((f) => f.path)).toEqual(['workflow.yaml'])
})

it.each(['=1+1', '+SUM(1,1)', '-SUM(1,1)', '@SUM(1,1)', '\t=1+1'])('exports %s as spreadsheet text rather than a formula', (value) => {
  const run = record()
  run.workflow = value
  const csv = toCsv(analyticsRows([run]))
  expect(csv).toContain("'" + value)
})

it('cannot close a report code fence through a step output', () => {
  const run = record()
  run.steps[0].output = '```\n<img src="https://example.invalid/track">\n```'
  const text = renderRunReport(run)
  expect(text).toContain('````json\n```')
})

it('escapes active Markdown/HTML in workflow metadata and reported metric names', () => {
  const run = record()
  run.workflow = '<img src="https://example.invalid/track">'
  run.steps[0].metrics = { '![track](https://example.invalid/track)': 1 }
  const text = renderRunReport(run)
  expect(text).not.toContain('<img src=')
  expect(text).not.toContain('![track](')
})

it('keeps imported step labels inside Mermaid nodes and distinct IDs distinct', () => {
  const run = record()
  run.steps = ['a-b', 'a_b', 'end', 'bad"\n```\n<img src=x>'].map((stepId) => ({ stepId, status: 'passed', attempt: 1, checks: [] }))
  const graph = mermaidFlow(runAnalytics(run))
  expect(graph).not.toContain('<img')
  expect(graph).not.toContain('```')
  expect(graph).not.toContain('bad"')
  const ids = graph.split('\n').slice(1).map((line) => line.trim().split('[')[0])
  expect(new Set(ids).size).toBe(4)
  expect(ids).not.toContain('end')
})
