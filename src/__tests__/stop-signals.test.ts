import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunStore } from '../state'

// WHY: docs/decisions/2026-11-16-stop-signals-and-closed-output.md
// Real processes on purpose: the defect was between flora, the OS and the
// step's process group, and a mocked spawn could not have shown it.

let dir: string
const spawned: ChildProcess[] = []
const pids: number[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-stop-'))
})
afterEach(() => {
  for (const child of spawned.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const pid of pids.splice(0)) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return ok()
}
const journalStatus = (): string | undefined => {
  const store = new RunStore(join(dir, 'flora.db'))
  try { return store.list()[0]?.status } finally { store.close() }
}

/** A workflow whose only step runs `script` under node; `pid` holds the step's pid once it is up. */
function workflow(script: string): { file: string; pid: () => number | undefined } {
  const pidFile = join(dir, 'step.pid')
  const js = join(dir, 'step.cjs')
  writeFileSync(js, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${script}\n`)
  const file = join(dir, 'wf.yaml')
  writeFileSync(file, `name: stop-test\nversion: 1\nsteps:\n  - id: long\n    title: long step\n    executor: { harness: command }\n    run: 'node ${js}'\n`)
  return {
    file,
    pid: () => {
      if (!existsSync(pidFile)) return undefined
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (pid && !pids.includes(pid)) pids.push(pid)
      return pid || undefined
    }
  }
}

function flora(file: string): { child: ChildProcess; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(process.execPath, ['bin/flora.mjs', 'run', file, '--cwd', dir], {
    cwd: process.cwd(),
    env: { ...process.env, FLORA_DB: join(dir, 'flora.db'), FLORA_HOME: join(dir, 'home') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  spawned.push(child)
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.on('exit', (code, signal) => done({ code, signal })))
  return { child, exit }
}

describe('a supervisor stops flora mid-step', () => {
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    it(`${signal}: the step dies with flora and the journal records the end`, async () => {
      const wf = workflow('setInterval(() => {}, 1000)')
      const { child, exit } = flora(wf.file)
      expect(await until(() => wf.pid() !== undefined, 15_000)).toBe(true)
      const stepPid = wf.pid()!

      child.kill(signal)
      const ended = await exit

      // An orderly stop is flora's own exit with a failing code, not death by the signal.
      expect(ended).toEqual({ code: 1, signal: null })
      expect(await until(() => !alive(stepPid), 3_000)).toBe(true)
      expect(journalStatus()).toBe('error')
    }, 30_000)
  }

  it('a second signal ends flora at once even when the stop is stuck', async () => {
    // The step ignores nothing here; what matters is that flora does not wait for a tidy end twice.
    const wf = workflow('setInterval(() => {}, 1000)')
    const { child, exit } = flora(wf.file)
    expect(await until(() => wf.pid() !== undefined, 15_000)).toBe(true)
    child.kill('SIGTERM')
    child.kill('SIGTERM')
    const ended = await exit
    expect(ended.signal).toBeNull()
    expect([1, 143]).toContain(ended.code)
  }, 30_000)
})

describe("flora's reader goes away mid-run", () => {
  it('the run goes on to its real result instead of exiting 0 half-way', async () => {
    const done = join(dir, 'done.txt')
    // Keeps printing after the reader is gone, then leaves proof that it ran to the end.
    const wf = workflow(`let n = 0; const t = setInterval(() => { console.log('tick', n); if (++n === 12) { clearInterval(t); require('fs').writeFileSync(${JSON.stringify(done)}, 'ok') } }, 250)`)
    const { child, exit } = flora(wf.file)
    child.stdout!.once('data', () => { child.stdout!.destroy(); child.stderr!.destroy() })

    const ended = await exit
    expect(existsSync(done)).toBe(true)
    expect(ended).toEqual({ code: 0, signal: null })
    expect(journalStatus()).toBe('passed')
  }, 40_000)

  it('a failing run still reports failure when nobody is reading', async () => {
    const wf = workflow(`let n = 0; const t = setInterval(() => { console.log('tick', n); if (++n === 8) { clearInterval(t); process.exit(3) } }, 250)`)
    const { child, exit } = flora(wf.file)
    child.stdout!.once('data', () => { child.stdout!.destroy(); child.stderr!.destroy() })
    const ended = await exit
    expect(ended).toEqual({ code: 1, signal: null })
    expect(journalStatus()).toBe('failed')
  }, 40_000)

  it('a listing piped into a reader that quits early still exits quietly', async () => {
    const child = spawn(process.execPath, ['bin/flora.mjs', 'runs', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, FLORA_DB: join(dir, 'flora.db') },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    spawned.push(child)
    child.stdout!.destroy()
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk })
    const code = await new Promise<number | null>((done) => child.on('exit', done))
    expect(code).toBe(0)
    expect(stderr).not.toMatch(/EPIPE|Error/)
  }, 30_000)
})
