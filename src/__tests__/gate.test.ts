import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GATE_MARKER, gateInstall, gateStatus, gateUninstall, hooksDir, hookScript } from '../gate'
import { FLORA_BIN } from '../tools'

let dir: string
let repo: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-gate-'))
  repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'flora@test'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'flora'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'])
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const workflow = (name: string, run: string): string => {
  const path = join(repo, `${name}.yaml`)
  writeFileSync(path, `name: ${name}\nparams:\n  remote: { default: '' }\n  url: { default: '' }\nsteps:\n  - id: check\n    executor: { harness: command }\n    run: '${run}'\n`)
  return path
}

describe('gate hook', () => {
  it.each([false, true])('passes shell metacharacters literally and uses its own Node (empty PATH: %s)', (emptyPath) => {
    const fakeBin = join(repo, 'fake-flora.cjs')
    writeFileSync(fakeBin, 'console.log(JSON.stringify(process.argv.slice(2)))')
    const strangeWorkflow = join(repo, "review$(echo INJECTED)'name.yaml")
    const hook = join(repo, 'test-hook')
    writeFileSync(hook, hookScript(repo, strangeWorkflow, fakeBin))
    const shell = process.platform === 'win32'
      ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../usr/bin/sh.exe')
      : '/bin/sh'
    const out = execFileSync(shell, [hook, 'origin', 'https://example.invalid/repo'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, ...(emptyPath ? { PATH: '' } : {}) }
    })
    expect(JSON.parse(out)).toEqual(['run', strangeWorkflow.replace(/\\/g, '/'), '--cwd', repo.replace(/\\/g, '/'), '--param', 'remote=origin', '--param', 'url=https://example.invalid/repo'])
  })

  it('does not claim ownership of a foreign hook that only mentions Flora', () => {
    const hook = join(hooksDir(repo), 'pre-push')
    writeFileSync(hook, `#!/bin/sh\n# maintained by another tool\n# ${GATE_MARKER}\necho safe\n`)
    expect(gateStatus(repo).ours).toBe(false)
    expect(() => gateUninstall(repo)).toThrow(/not flora/)
  })

  it('installs an executable hook that runs the workflow with the push details, and reports it', () => {
    const wf = workflow('ok', 'echo fine')
    const status = gateInstall(repo, wf)
    expect(status).toMatchObject({ installed: true, ours: true, workflow: wf.replace(/\\/g, '/') })
    expect(status.hookPath).toBe(join(hooksDir(repo), 'pre-push'))

    const text = readFileSync(status.hookPath, 'utf8')
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).toContain(GATE_MARKER)
    expect(text).toContain(`'${FLORA_BIN.replace(/\\/g, '/')}' run`)
    expect(text).toContain('--param "remote=$1" --param "url=$2"')
    if (process.platform !== 'win32') expect(statSync(status.hookPath).mode & 0o111).not.toBe(0)

    // Idempotent: installing again just rewrites ours.
    expect(gateInstall(repo, wf).ours).toBe(true)
    expect(gateStatus(repo).stale).toBeUndefined()
  })

  it('refuses a missing workflow and never touches a hook that is not ours', () => {
    expect(() => gateInstall(repo, 'nope.yaml')).toThrow(/workflow not found/)
    const hook = join(hooksDir(repo), 'pre-push')
    writeFileSync(hook, '#!/bin/sh\necho theirs\n')
    expect(() => gateInstall(repo, workflow('ok', 'echo fine'))).toThrow(/not flora's/)
    expect(readFileSync(hook, 'utf8')).toContain('theirs')
    expect(gateStatus(repo)).toMatchObject({ installed: true, ours: false })
    expect(() => gateUninstall(repo)).toThrow(/not flora's/)
    expect(existsSync(hook)).toBe(true)
  })

  it('uninstall removes ours and says when there was nothing', () => {
    expect(gateUninstall(repo)).toBe(false)
    gateInstall(repo, workflow('ok', 'echo fine'))
    expect(gateUninstall(repo)).toBe(true)
    expect(gateStatus(repo).installed).toBe(false)
  })

  it('reports a stale hook when the workflow file went away', () => {
    const wf = workflow('ok', 'echo fine')
    gateInstall(repo, wf)
    rmSync(wf)
    expect(gateStatus(repo).stale).toMatch(/workflow file is gone/)
  })

  it('honours core.hooksPath', () => {
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.githooks'])
    const status = gateInstall(repo, workflow('ok', 'echo fine'))
    expect(status.hookPath).toBe(join(repo, '.githooks', 'pre-push'))
  })
})

describe('gate with a real git push', () => {
  const push = (): { code: number; output: string } => {
    try {
      const output = execFileSync('git', ['-C', repo, 'push', 'origin', 'HEAD:main'], {
        encoding: 'utf8',
        env: { ...process.env, FLORA_DB: join(dir, 'flora.db') },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return { code: 0, output }
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return { code: e.status, output: `${e.stdout}${e.stderr}` }
    }
  }
  const remoteHasMain = (): boolean => {
    try {
      return execFileSync('git', ['-C', join(dir, 'remote.git'), 'rev-parse', '--verify', 'refs/heads/main'], { encoding: 'utf8' }).trim().length > 0
    } catch {
      return false
    }
  }

  beforeEach(() => {
    execFileSync('git', ['init', '-q', '--bare', join(dir, 'remote.git')])
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', join(dir, 'remote.git')])
  })

  it('a failing contract blocks the push, a passing one lets it through', () => {
    gateInstall(repo, workflow('deny', 'node -e "console.log(\\"nope\\"); process.exit(1)"'))
    const blocked = push()
    expect(blocked.code).not.toBe(0)
    expect(blocked.output).toMatch(/run failed|pre-push hook declined/)
    expect(remoteHasMain()).toBe(false)

    gateInstall(repo, workflow('allow', 'echo reviewed'))
    const allowed = push()
    expect(allowed.code).toBe(0)
    expect(allowed.output).toContain('run passed')
    expect(remoteHasMain()).toBe(true)
  }, 60_000)
})
