import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { delimiter, dirname, extname, join, resolve as resolvePath } from 'node:path'
import type { Evidence } from '../types'
import type { ExecuteInput, HarnessAdapter } from './types'
import { attachUsage } from './usage'

/** Wall-clock ceiling: how long a step may run in total. */
export const DEFAULT_TIMEOUT_MIN = 15
/** Silence ceiling: how long a step may go without writing a byte. */
export const DEFAULT_STALL_MIN = 5

/** Exit code reported for a process flora had to kill (128 + SIGKILL). */
export const KILLED_EXIT_CODE = 137

export type RunCommandInput = Pick<ExecuteInput, 'cwd' | 'signal' | 'onOutput' | 'env'> & {
  /** Minutes; fractional is fine. 0 disables. */
  timeoutMin?: number
  /** Minutes; fractional is fine. 0 disables. */
  stallMin?: number
}

type EndReason = 'stalled' | 'timedOut' | 'aborted'

/**
 * Spawn a command and collect its output — the base for every CLI-harness adapter.
 *
 * Two timers watch two different diseases: `stallMin` catches a harness that
 * stopped talking (an API call that never returns, a prompt nobody answers),
 * `timeoutMin` catches work that keeps going and never finishes. Either one,
 * or an abort, kills the whole process tree, not just the direct child — a
 * headless harness is usually a shell wrapping a node wrapping a CLI.
 *
 * stdin is closed by construction: a harness that stops to ask a question
 * reads EOF instead of waiting forever for an answer that is not coming.
 */
export function runCommand(
  command: string,
  args: string[],
  input: RunCommandInput,
  options: { shell?: boolean } = {}
): Promise<Evidence> {
  const started = Date.now()
  if (input.signal?.aborted) return Promise.resolve({ output: '[flora: aborted]', exitCode: KILLED_EXIT_CODE, durationMs: 0 })
  const env = { ...process.env }
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (process.platform === 'win32') for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing]
    env[key] = value
  }
  const timeoutMin = input.timeoutMin ?? DEFAULT_TIMEOUT_MIN
  const stallMin = input.stallMin ?? DEFAULT_STALL_MIN
  const timeoutMs = minutesToMs(timeoutMin)
  const stallMs = minutesToMs(stallMin)
  const plan = options.shell ? { command, args, verbatim: false } : resolveCommand(command, args, env, input.cwd)

  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: input.cwd,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group on POSIX so one signal reaches the whole tree.
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      env
    })

    let output = ''
    let ended: EndReason | null = null
    let stallTimer: NodeJS.Timeout | null = null
    let wallTimer: NodeJS.Timeout | null = null
    let observerFailed = false
    let observerError: unknown
    let settled = false

    const end = (reason: EndReason): void => {
      if (ended) return
      ended = reason
      killTree(child)
    }

    const armStall = (): void => {
      if (!stallMs) return
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => end('stalled'), stallMs)
      stallTimer.unref?.()
    }

    const collect = (decoder: OutputDecoder) => (chunk: Buffer): void => {
      if (ended) return
      const text = decoder.decode(chunk)
      if (!text) return
      output += text
      try { input.onOutput?.(text) } catch (error) {
        observerFailed = true
        observerError = error
        end('aborted')
        return
      }
      armStall()
    }
    const decoders = { stdout: new OutputDecoder(), stderr: new OutputDecoder() }
    child.stdout?.on('data', collect(decoders.stdout))
    child.stderr?.on('data', collect(decoders.stderr))
    child.on('close', () => {
      output += decoders.stdout.end() + decoders.stderr.end()
    })

    if (timeoutMs) {
      wallTimer = setTimeout(() => end('timedOut'), timeoutMs)
      wallTimer.unref?.()
    }
    armStall()

    const onAbort = (): void => end('aborted')
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()

    const finish = (evidence: Evidence): void => {
      if (settled) return
      settled = true
      if (stallTimer) clearTimeout(stallTimer)
      if (wallTimer) clearTimeout(wallTimer)
      input.signal?.removeEventListener('abort', onAbort)
      if (observerFailed) reject(observerError)
      else resolve(evidence)
    }

    child.on('error', (err) => {
      finish({
        output: `${output}\n[spawn error: ${err.message}]`.trim(),
        exitCode: null,
        durationMs: Date.now() - started
      })
    })

    child.on('close', (code) => {
      if (!ended) {
        finish({ output: output.trim(), exitCode: code, durationMs: Date.now() - started })
        return
      }
      const note =
        ended === 'stalled'
          ? `[flora: killed after ${stallMin} min without output]`
          : ended === 'timedOut'
            ? `[flora: killed at the ${timeoutMin} min wall-clock limit]`
            : '[flora: aborted]'
      finish({
        output: `${output.trim()}\n${note}`.trim(),
        // A process we killed must never look like a success, whatever the
        // platform reports for a forced termination.
        exitCode: code && code !== 0 ? code : KILLED_EXIT_CODE,
        durationMs: Date.now() - started,
        ...(ended === 'stalled' ? { stalled: true } : {}),
        ...(ended === 'timedOut' ? { timedOut: true } : {})
      })
    })
  })
}

/** Kill a child and everything it spawned. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    // taskkill /T walks the tree; /F because a stalled process is not going
    // to honour a polite request.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => child.kill('SIGKILL')
    )
    return
  }
  try {
    // Negative pid = the whole process group we created with `detached`.
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function minutesToMs(minutes: number): number {
  return minutes > 0 ? Math.round(minutes * 60_000) : 0
}

// ── Text from a child process ─────────────────────────────────────────────

/**
 * Everything sane writes UTF-8, but on Windows cmd.exe and its built-ins
 * write the console's OEM code page (866 on a Russian system, 437 on an
 * English one), and reading that as UTF-8 puts mojibake into the journal.
 * Each stream gets a strict, streaming UTF-8 decoder; a chunk it rejects is
 * decoded with the console's OEM page instead. Chunks from the two writers
 * practically never share a read, so the per-chunk decision holds up.
 */
export class OutputDecoder {
  private utf8 = new TextDecoder('utf-8', { fatal: true })

  decode(chunk: Buffer): string {
    try {
      return this.utf8.decode(chunk, { stream: true })
    } catch {
      this.utf8 = new TextDecoder('utf-8', { fatal: true })
      return oemDecoder().decode(chunk)
    }
  }

  /** Whatever a trailing partial sequence left behind. */
  end(): string {
    try {
      return this.utf8.decode()
    } catch {
      return ''
    }
  }
}

let oem: TextDecoder | null = null

/** The console's OEM code page as a WHATWG decoder; Latin-1-ish when unknown. */
export function oemDecoder(): TextDecoder {
  if (oem) return oem
  const labels = ['windows-1252']
  if (process.platform === 'win32') {
    try {
      const out = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'latin1', windowsHide: true }).stdout ?? ''
      const page = /(\d+)\s*$/.exec(out.trim())?.[1]
      if (page === '866') labels.unshift('ibm866')
      else if (page) labels.unshift(`windows-${page}`)
    } catch {
      // no console to ask — fall through to the default
    }
  }
  for (const label of labels) {
    try {
      oem = new TextDecoder(label)
      return oem
    } catch {
      // unsupported label (e.g. 437), try the next
    }
  }
  oem = new TextDecoder('windows-1252')
  return oem
}

// ── Windows: running a CLI that is really an npm shim ─────────────────────

export interface SpawnPlan {
  command: string
  args: string[]
  /** Hand the argument line to CreateProcess untouched (cmd.exe route only). */
  verbatim: boolean
}

/**
 * On Windows `spawn('codex')` fails with ENOENT even though `codex` works in
 * every terminal: npm installs CLIs as `codex.cmd` batch shims, and
 * CreateProcess only knows about executables. This resolves the name through
 * PATH/PATHEXT the way a shell would. A real .exe is spawned directly. An npm
 * shim is unwrapped and its JavaScript entry run with our own node — so the
 * arguments (multi-line prompts included) never pass through cmd.exe. Any
 * other batch file goes through cmd.exe with cross-spawn's escaping; cmd
 * cannot carry newlines in arguments, which is why unwrapping comes first.
 */
export function resolveCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): SpawnPlan {
  const direct = { command, args, verbatim: false }
  if (process.platform !== 'win32') return direct
  const batch = (file: string): SpawnPlan => {
    const entry = npmShimEntry(file)
    if (entry) return { command: process.execPath, args: [entry, ...args], verbatim: false }
    if (args.some((arg) => /[\r\n\0]/.test(arg))) throw new Error('batch files cannot safely accept multiline arguments; use an executable or npm CLI shim')
    const line = [escapeForCmd(file, false), ...args.map((arg) => escapeForCmd(arg, true))].join(' ')
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
  }
  if (/[\\/]/.test(command)) return /\.(cmd|bat)$/i.test(command) ? batch(resolvePath(cwd, command)) : direct
  if (extname(command) && !/\.(cmd|bat)$/i.test(command)) return direct

  const pathValue = env[Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'] ?? ''
  const exts = extname(command) ? [''] : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = join(dir, command + ext)
      if (!existsSync(file)) continue
      if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args, verbatim: false }
      return batch(file)
    }
  }
  return direct
}

/**
 * Shims written by npm's cmd-shim end in
 * `"%_prog%"  "%dp0%\node_modules\<pkg>\bin\cli.js" %*` — that JS file is the
 * real program. Returns its absolute path, or null if this is not such a shim.
 */
export function npmShimEntry(shimPath: string): string | null {
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const match = /"%dp0%\\([^"]+\.[cm]?js)"\s+%\*/i.exec(text) ?? /"%~dp0\\([^"]+\.[cm]?js)"\s+%\*/i.exec(text)
  if (!match) return null
  // The shim spells the path with backslashes; on POSIX (tests, WSL) join() would keep them.
  const entry = join(dirname(shimPath), ...match[1].split(/[\\/]+/))
  return existsSync(entry) ? entry : null
}

/**
 * cross-spawn's argument escaping for the cmd.exe route: quote for
 * CreateProcess, then caret-escape everything cmd.exe would interpret. Batch
 * files parse the line a second time, hence the double escape.
 */
export function escapeForCmd(arg: string, isArgument: boolean): string {
  const meta = /([()\][%!^"`<>&|;, *?])/g
  if (!isArgument) return arg.replace(meta, '^$1')
  let text = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')
  text = `"${text}"`.replace(meta, '^$1')
  return text.replace(meta, '^$1')
}

export const commandAdapter: HarnessAdapter = {
  name: 'command',
  async execute(input): Promise<Evidence> {
    if (!input.run) return { output: 'command adapter: nothing to run', exitCode: null, durationMs: 0 }
    // A script that fans out over a model API can print what it spent (a
    // JSON line with `usage` / `cost_usd`, or `tokens used: …`); it lands in
    // the journal like a harness's own accounting.
    return attachUsage(
      await runCommand(
        input.run,
        [],
        { ...input, timeoutMin: input.spec.timeout_min, stallMin: input.spec.stall_min },
        { shell: true }
      )
    )
  }
}
