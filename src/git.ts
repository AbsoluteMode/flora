import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Run git in a repository; failures carry git's own message. */
async function git(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    throw new Error(`git ${args[0]} failed: ${(e.stderr ?? e.message).trim()}`)
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

/** Uncommitted changes in the working copy — the ones a worktree from HEAD will not see. */
export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).trim().length > 0
}

/**
 * A detached worktree at HEAD: the committed state, reproducible, nothing
 * from the working copy. Each parallel branch gets one.
 */
export async function addWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', path, 'HEAD'])
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', path])
}

/** Forget worktrees whose directories are gone (a crashed run, a reboot). */
export async function pruneWorktrees(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune'])
}

/**
 * Everything a branch changed in its worktree, untracked files included, as
 * one patch against HEAD. Empty string when it changed nothing.
 */
export async function worktreePatch(repo: string, worktree: string): Promise<string> {
  await git(worktree, ['add', '-A'])
  return git(worktree, ['diff', '--cached', '--binary', 'HEAD'])
}

/** The worktree paths git knows about for a repository (the main one first). */
export async function listWorktrees(repo: string): Promise<string[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain'])
  return out
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}
