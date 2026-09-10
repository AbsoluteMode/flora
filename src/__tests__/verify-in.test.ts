import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { schemaErrors } from '../contract'
import { runWorkflow } from '../engine'
import { listWorktrees } from '../git'
import { validateWorkflow } from '../workflow'
import type { StepSpec, WorkflowSpec } from '../types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-verify-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
const initRepo = (): void => {
  git('init', '-q')
  git('config', 'user.email', 'flora@test')
  git('config', 'user.name', 'flora')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

// Writes result.txt; commits it only when asked.
const writer = (commit: boolean, verifyIn?: 'cwd' | 'worktree'): WorkflowSpec => ({
  name: 'verify',
  steps: [
    {
      id: 'work',
      executor: { harness: 'command' },
      run: commit
        ? 'node -e "require(\'fs\').writeFileSync(\'result.txt\', \'done\')" && git add -A && git -c user.email=f@t -c user.name=f commit -q -m work'
        : 'node -e "require(\'fs\').writeFileSync(\'result.txt\', \'done\')"',
      ...(verifyIn ? { verify_in: verifyIn } : {}),
      verify: [{ type: 'artifact', path: 'result.txt', contains: 'done' }]
    }
  ]
})

describe('verify_in contract', () => {
  it('accepts cwd and worktree, refuses anything else and any use on a parallel step', () => {
    expect(() => validateWorkflow(writer(false, 'worktree'))).not.toThrow()
    expect(schemaErrors(writer(false, 'worktree'))).toEqual([])
    const bad = { ...writer(false), steps: [{ ...writer(false).steps[0], verify_in: 'branch' }] } as unknown as WorkflowSpec
    expect(() => validateWorkflow(bad)).toThrow(/verify_in must be/)
    expect(schemaErrors(bad).length).toBeGreaterThan(0)
    const onParallel = {
      name: 'p',
      steps: [{ id: 'p', verify_in: 'worktree', parallel: { branches: [{ executor: { harness: 'command' }, run: 'x' }] } } as StepSpec]
    }
    expect(() => validateWorkflow(onParallel)).toThrow(/does not apply to a parallel step/)
    expect(schemaErrors(onParallel).length).toBeGreaterThan(0)
  })
})

describe('verify_in at run time', () => {
  it('cwd: an uncommitted file satisfies the check (as always)', async () => {
    initRepo()
    const record = await runWorkflow(writer(false, 'cwd'), { cwd: dir })
    expect(record.status).toBe('passed')
    expect(record.steps[0].verifiedIn).toBeUndefined()
  })

  it('worktree: the same uncommitted file does not — only the committed state counts', async () => {
    initRepo()
    const record = await runWorkflow(writer(false, 'worktree'), { cwd: dir })
    expect(record.status).toBe('failed')
    expect(record.steps[0].checks[0]).toMatchObject({ passed: false, detail: 'result.txt does not exist' })
    expect(record.steps[0].verifiedIn).toBe('worktree')
    expect(await listWorktrees(dir)).toHaveLength(1) // cleaned up
  }, 20_000)

  it('worktree: a committed file passes, and the worktree is gone afterwards', async () => {
    initRepo()
    const record = await runWorkflow(writer(true, 'worktree'), { cwd: dir })
    expect(record.status).toBe('passed')
    expect(record.steps[0].checks[0].passed).toBe(true)
    expect(record.steps[0].verifiedIn).toBe('worktree')
    expect(await listWorktrees(dir)).toHaveLength(1)
  }, 20_000)

  it('worktree outside a git repository fails the step with the way out', async () => {
    const record = await runWorkflow(writer(false, 'worktree'), { cwd: dir })
    expect(record.status).toBe('failed')
    expect(record.steps[0].error).toMatch(/git repository.*drop verify_in/)
    expect(record.steps[0].checks).toEqual([])
  })
})
