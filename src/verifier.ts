import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckResult, CheckSpec } from './types'
import { runCommand } from './adapters/command'

const CHECK_TIMEOUT_MIN = 10

/**
 * The verifier runs checks itself — never the executor. A step passes only
 * when every check passes. (v0 runs in the run cwd; committed-state worktree
 * isolation is the next hardening step.)
 */
export async function runChecks(
  checks: CheckSpec[],
  cwd: string,
  signal?: AbortSignal,
  env?: Record<string, string>
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of checks) {
    results.push(await runCheck(check, cwd, signal, env))
  }
  return results
}

async function runCheck(
  check: CheckSpec,
  cwd: string,
  signal?: AbortSignal,
  env?: Record<string, string>
): Promise<CheckResult> {
  if (check.type === 'command') {
    const evidence = await runCommand(
      check.run!,
      [],
      { cwd, signal, env, timeoutMin: CHECK_TIMEOUT_MIN },
      { shell: true }
    )
    const wantExit = check.expect_exit ?? 0
    const exitOk = evidence.exitCode === wantExit
    const matchOk = check.expect_match ? evidence.output.includes(check.expect_match) : true
    return {
      check,
      passed: exitOk && matchOk,
      detail: exitOk
        ? matchOk
          ? `exit ${evidence.exitCode}`
          : `output does not contain "${check.expect_match}"`
        : `exit ${evidence.exitCode ?? 'none'} (wanted ${wantExit}): ${tail(evidence.output)}`
    }
  }
  // artifact
  try {
    const content = readFileSync(join(cwd, check.path!), 'utf8')
    const containsOk = check.contains ? content.includes(check.contains) : true
    return {
      check,
      passed: containsOk,
      detail: containsOk ? `${check.path} exists` : `${check.path} does not contain "${check.contains}"`
    }
  } catch {
    return { check, passed: false, detail: `${check.path} does not exist` }
  }
}

function tail(text: string, max = 300): string {
  const flat = text.trim()
  return flat.length > max ? '…' + flat.slice(-max) : flat
}
