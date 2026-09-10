import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { schemaErrors } from '../contract'
import { runWorkflow } from '../engine'
import { listWorktrees } from '../git'
import { loadWorkflow, parseRequire, validateWorkflow, WorkflowError } from '../workflow'
import type { BranchSpec, RunEvent, WorkflowSpec } from '../types'

let dir: string
let artifacts: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-par-'))
  artifacts = join(dir, 'artifacts')
})
afterEach(() => {
  delete process.env.FLORA_MAX_PARALLEL
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// The object literal uses single quotes: the whole script sits inside the
// shell's double quotes, and cmd.exe has no escaping for a nested `"`.
const sleepThenJson = (ms: number, value: unknown): BranchSpec => ({
  executor: { harness: 'command' },
  run: `node -e "setTimeout(() => console.log(JSON.stringify(${JSON.stringify(value).replace(/"/g, "'")})), ${ms})"`,
  output: { type: 'json' }
})
const failing: BranchSpec = { executor: { harness: 'command' }, run: 'node -e "process.exit(1)"' }

const parallelSpec = (branches: BranchSpec[], extra: Partial<WorkflowSpec['steps'][0]['parallel']> = {}, more: WorkflowSpec['steps'] = []): WorkflowSpec => ({
  name: 'par',
  steps: [{ id: 'solve', parallel: { isolation: 'shared', branches, ...extra } }, ...more]
})

describe('parallel contract', () => {
  it('parses the require policy', () => {
    expect(parseRequire(undefined, 3)).toEqual({ kind: 'all', n: 3 })
    expect(parseRequire('any', 3)).toEqual({ kind: 'any', n: 1 })
    expect(parseRequire('quorum:2', 3)).toEqual({ kind: 'quorum', n: 2 })
    expect(() => parseRequire('most', 3)).toThrow(WorkflowError)
    expect(() => parseRequire('quorum:4', 3)).toThrow(/impossible/)
    expect(() => parseRequire('quorum:0', 3)).toThrow(/impossible/)
  })

  it.each([
    ['executor and parallel together', { id: 'a', executor: { harness: 'command' }, run: 'x', parallel: { branches: [failing] } }, /exactly one/],
    ['neither', { id: 'a' }, /exactly one/],
    ['a step-level run next to parallel', { id: 'a', run: 'x', parallel: { branches: [failing] } }, /belongs on the branches/],
    ['no branches', { id: 'a', parallel: { branches: [] } }, /non-empty/],
    ['a bad policy', { id: 'a', parallel: { require: 'most', branches: [failing] } }, /require must be/],
    ['a bad isolation', { id: 'a', parallel: { isolation: 'none', branches: [failing] } }, /isolation/],
    ['a branch with an id', { id: 'a', parallel: { branches: [{ id: 'b', ...failing }] } }, /unknown field "id"/],
    ['a nested parallel', { id: 'a', parallel: { branches: [{ parallel: { branches: [failing] } }] } }, /unknown field "parallel"/],
    ['a branch without a runner', { id: 'a', parallel: { branches: [{ title: 'x' }] } }, /executor.harness is required/]
  ])('refuses %s in code and in the schema', (_name, step, message) => {
    const spec = { name: 'w', steps: [step] } as unknown as WorkflowSpec
    expect(() => validateWorkflow(spec)).toThrow(message)
    expect(schemaErrors(spec).length).toBeGreaterThan(0)
  })

  it('refuses an impossible quorum (code only — a schema cannot count branches)', () => {
    expect(() => validateWorkflow(parallelSpec([failing, failing], { require: 'quorum:3' }))).toThrow(/impossible/)
  })

  it('accepts a well-formed parallel step, and the shipped example', () => {
    const spec = parallelSpec([sleepThenJson(1, { a: 1 }), failing], { require: 'quorum:1' })
    expect(() => validateWorkflow(spec)).not.toThrow()
    expect(schemaErrors(spec)).toEqual([])
    const example = loadWorkflow(join(process.cwd(), 'examples', 'solve-and-collect.yaml'))
    expect(schemaErrors(example)).toEqual([])
  })
})

describe('parallel engine', () => {
  it('runs branches at the same time, journals each, and exposes outputs to the next step', async () => {
    const events: RunEvent[] = []
    const record = await runWorkflow(
      parallelSpec([sleepThenJson(1000, { by: 'a' }), sleepThenJson(1000, { by: 'b' }), sleepThenJson(1000, { by: 'c' })], {}, [
        {
          id: 'collect',
          executor: { harness: 'command' },
          run: 'node -e "const c = require(process.env.FLORA_CONTEXT); console.log(c.steps.solve.outputs.map(o => o.by).join(\'+\'))"',
          verify: [{ type: 'command', run: 'node -e "console.log(require(process.env.FLORA_CONTEXT).steps.solve.outputs.length)"', expect_match: '{{steps.solve.outputs.length}}' }]
        }
      ]),
      { cwd: dir, artifactsDir: artifacts, onEvent: (e) => events.push(e) }
    )
    expect(record.status).toBe('passed')
    const starts = [0, 1, 2].map((branch) => events.findIndex((e) => e.type === 'branch_start' && e.branch === branch))
    const finishes = [0, 1, 2].map((branch) => events.findIndex((e) => e.type === 'branch_result' && e.branch === branch))
    expect([...starts, ...finishes].every((index) => index >= 0)).toBe(true)
    expect(Math.max(...starts)).toBeLessThan(Math.min(...finishes))
    expect(events.findIndex((e) => e.type === 'step_start' && e.stepId === 'collect')).toBeGreaterThan(Math.max(...finishes))

    const solve = record.steps[0]
    expect(solve.harness).toBe('parallel')
    expect(solve.branches?.map((b) => b.stepId)).toEqual(['solve[0]', 'solve[1]', 'solve[2]'])
    expect(solve.outputs).toEqual([{ by: 'a' }, { by: 'b' }, { by: 'c' }])
    expect(solve.patches).toEqual([null, null, null]) // shared isolation: nothing to diff
    expect(record.steps[1].evidence?.output).toBe('a+b+c')

    expect(events.filter((e) => e.type === 'branch_start').map((e) => e.branch)).toEqual([0, 1, 2])
    expect(events.filter((e) => e.type === 'branch_result').every((e) => e.status === 'passed')).toBe(true)
    expect(events.filter((e) => e.type === 'executor_output' && e.branch !== undefined).length).toBeGreaterThan(0)
  }, 20_000)

  it('honours FLORA_MAX_PARALLEL', async () => {
    process.env.FLORA_MAX_PARALLEL = '1'
    const started = Date.now()
    const record = await runWorkflow(parallelSpec([sleepThenJson(700, 1), sleepThenJson(700, 2), sleepThenJson(700, 3)]), { cwd: dir, artifactsDir: artifacts })
    expect(record.status).toBe('passed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000)
  }, 20_000)

  it.each([
    ['all', 'failed'],
    ['any', 'passed'],
    ['quorum:2', 'passed'],
    ['quorum:3', 'failed']
  ])('require %s with two of three passing → %s', async (require, expected) => {
    const record = await runWorkflow(parallelSpec([sleepThenJson(10, 1), failing, sleepThenJson(10, 3)], { require }), { cwd: dir, artifactsDir: artifacts })
    expect(record.status).toBe(expected)
    const solve = record.steps[0]
    expect(solve.outputs).toEqual([1, null, 3])
    if (expected === 'failed') expect(solve.error).toMatch(/2 of 3 branches passed/)
  }, 20_000)

  it('retries the whole step when the policy fails and on_fail allows it', async () => {
    const events: RunEvent[] = []
    const record = await runWorkflow(
      { name: 'retry', steps: [{ id: 'solve', on_fail: { retry: 1 }, parallel: { isolation: 'shared', branches: [failing] } }] },
      { cwd: dir, artifactsDir: artifacts, onEvent: (e) => events.push(e) }
    )
    expect(record.status).toBe('failed')
    expect(record.steps[0].attempt).toBe(2)
    expect(events.filter((e) => e.type === 'branch_start')).toHaveLength(2)
  }, 20_000)
})

describe('worktree isolation', () => {
  const git = (args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })

  const initRepo = (): void => {
    git(['init', '-q'])
    git(['config', 'user.email', 'flora@test'])
    git(['config', 'user.name', 'flora'])
    writeFileSync(join(dir, 'README.md'), 'hello\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'init'])
  }

  it('gives every branch a worktree of HEAD, collects a patch, and leaves the working copy alone', async () => {
    initRepo()
    writeFileSync(join(dir, 'uncommitted.txt'), 'not in HEAD\n')
    const branch = (n: number): BranchSpec => ({
      executor: { harness: 'command' },
      run: `node -e "const fs = require('fs'); fs.writeFileSync('b${n}.txt', 'branch ${n}'); fs.writeFileSync('README.md', 'edited by ${n}'); console.log(fs.existsSync('uncommitted.txt') ? 'saw-dirty' : 'clean-head')"`,
      verify: [{ type: 'artifact', path: `b${n}.txt`, contains: `branch ${n}` }]
    })
    const record = await runWorkflow(
      { name: 'wt', steps: [{ id: 'solve', parallel: { branches: [branch(0), branch(1)] } }] },
      { cwd: dir, artifactsDir: artifacts }
    )
    expect(record.status).toBe('passed')
    const solve = record.steps[0]
    // Branches start from the commit, not from the dirty working copy.
    expect(solve.branches?.map((b) => b.evidence?.output)).toEqual(['clean-head', 'clean-head'])
    // Their checks ran inside their own worktrees.
    expect(solve.branches?.every((b) => b.checks[0].passed)).toBe(true)
    // The working copy did not change; the patches carry what each branch did.
    expect(existsSync(join(dir, 'b0.txt'))).toBe(false)
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('hello\n')
    expect(solve.patches?.map((p) => (p ? readFileSync(p, 'utf8') : null))).toEqual([
      expect.stringContaining('b0.txt'),
      expect.stringContaining('b1.txt')
    ])
    expect(readFileSync(solve.patches![0]!, 'utf8')).toContain('edited by 0') // README change is in branch 0's patch
    // No worktrees left behind.
    expect(await listWorktrees(dir)).toHaveLength(1)
  }, 30_000)

  it('reports a branch that changed nothing as a null patch', async () => {
    initRepo()
    const record = await runWorkflow(
      { name: 'wt', steps: [{ id: 'solve', parallel: { branches: [{ executor: { harness: 'command' }, run: 'echo nothing' }] } }] },
      { cwd: dir, artifactsDir: artifacts }
    )
    expect(record.status).toBe('passed')
    expect(record.steps[0].patches).toEqual([null])
  }, 20_000)

  it('refuses worktree isolation outside a git repository, with the way out in the message', async () => {
    const record = await runWorkflow(
      { name: 'wt', steps: [{ id: 'solve', parallel: { branches: [sleepThenJson(1, 1)] } }] },
      { cwd: dir, artifactsDir: artifacts }
    )
    expect(record.status).toBe('failed')
    expect(record.steps[0].error).toMatch(/git repository.*isolation: shared/)
  })
})

describe('shipped example', () => {
  it('solve-and-collect: a quorum of two survives the flaky branch and the collector merges the answers', async () => {
    const example = loadWorkflow(join(process.cwd(), 'examples', 'solve-and-collect.yaml'))
    const record = await runWorkflow(example, { cwd: dir, artifactsDir: artifacts })
    expect(record.status).toBe('passed')
    expect(record.steps[0].outputs).toEqual([{ by: 'fast', answer: 42 }, { by: 'careful', answer: 42 }, null])
    expect(record.steps[1].output).toEqual({ question: 'the answer', answers: 2, agreed: true, answer: 42 })
  }, 20_000)
})
