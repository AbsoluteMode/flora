import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { escapeForCmd, npmShimEntry, resolveCommand, runCommand } from '../adapters/command'

/**
 * npm installs CLIs on Windows as `.cmd` batch shims, which CreateProcess
 * cannot start. These cases build such shims in a temp dir, put it first on
 * PATH, and run them through runCommand exactly like a harness adapter would.
 */
const onWindows = process.platform === 'win32'

/** What npm's cmd-shim writes, verbatim shape. */
const NPM_SHIM = (target: string) =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    ''
  ].join('\r\n')

let dir: string
let savedPath: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-shim-'))
  savedPath = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`
})

afterEach(() => {
  process.env.PATH = savedPath
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe.runIf(onWindows)('npm shims on Windows', () => {
  it('unwraps an npm .cmd shim and runs its JS entry with our node — newlines survive', async () => {
    mkdirSync(join(dir, 'node_modules', 'fake-cli', 'bin'), { recursive: true })
    writeFileSync(
      join(dir, 'node_modules', 'fake-cli', 'bin', 'cli.js'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)))'
    )
    writeFileSync(join(dir, 'fake-cli.cmd'), NPM_SHIM('node_modules\\fake-cli\\bin\\cli.js'))

    const plan = resolveCommand('fake-cli', ['x'])
    expect(plan.command).toBe(process.execPath)
    expect(plan.args[0]).toMatch(/cli\.js$/)

    const prompt = 'Review the diff.\n\nPrint "REVIEW_CLEAN" if fine; 100% sure & done.'
    const evidence = await runCommand('fake-cli', [prompt, 'second arg'], { cwd: dir, stallMin: 0 })
    expect(evidence.exitCode).toBe(0)
    expect(JSON.parse(evidence.output)).toEqual([prompt, 'second arg'])
  })

  it('runs an ordinary .cmd through cmd.exe with escaped arguments', async () => {
    // A batch file forwards its arguments with %*, so what reaches the program
    // it launches is the quoted form — spaces and metacharacters intact.
    writeFileSync(join(dir, 'plain.cmd'), '@echo off\r\necho %*\r\n')

    const plan = resolveCommand('plain', ['a b', 'c'])
    expect(plan.command.toLowerCase()).toContain('cmd')
    expect(plan.verbatim).toBe(true)

    const evidence = await runCommand('plain', ['a b', 'c&d'], { cwd: dir, stallMin: 0 })
    expect(evidence.exitCode).toBe(0)
    expect(evidence.output).toBe('"a b" "c&d"')
  })

  it('leaves real executables, paths and extensions alone', () => {
    expect(resolveCommand('node.exe', ['-v'])).toEqual({ command: 'node.exe', args: ['-v'], verbatim: false })
    expect(resolveCommand('C:\\tools\\thing', [])).toEqual({ command: 'C:\\tools\\thing', args: [], verbatim: false })
    const node = resolveCommand('node', ['-v'])
    expect(node.command.toLowerCase()).toMatch(/node\.exe$/)
  })

  it('an unknown command resolves to itself so spawn reports ENOENT as before', () => {
    expect(resolveCommand('no-such-cli-xyz', [])).toEqual({ command: 'no-such-cli-xyz', args: [], verbatim: false })
  })
})

describe('child output decoding', () => {
  it('keeps UTF-8 from a well-behaved program intact', async () => {
    const evidence = await runCommand('node', ['-e', "console.log('Привет, мир — ok')"], { cwd: dir, stallMin: 0 })
    expect(evidence.output).toBe('Привет, мир — ok')
  })

  it.runIf(onWindows)('turns cmd.exe OEM output into readable text instead of mojibake', async () => {
    // cmd's own echo writes the console code page, not UTF-8. The sample has
    // to exist in that page: Cyrillic on 866, accented Latin on 437/1252.
    const page = /(\d+)\s*$/.exec(execFileSync('cmd.exe', ['/d', '/c', 'chcp'], { encoding: 'latin1' }).trim())?.[1]
    const sample = page === '866' ? 'Привет из cmd' : page === '437' || page === '1252' ? 'café crème' : null
    if (!sample) return // an OEM page with nothing we can spell — nothing to prove here
    const evidence = await runCommand(`echo ${sample}`, [], { cwd: dir, stallMin: 0 }, { shell: true })
    expect(evidence.output).toBe(sample)
  })
})

describe('shim helpers', () => {
  it('reads the JS entry out of an npm shim and ignores other batch files', () => {
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'x', 'cli.js'), '')
    writeFileSync(join(dir, 'x.cmd'), NPM_SHIM('node_modules\\x\\cli.js'))
    writeFileSync(join(dir, 'plain.cmd'), '@echo off\r\necho hi\r\n')

    expect(npmShimEntry(join(dir, 'x.cmd'))).toBe(join(dir, 'node_modules', 'x', 'cli.js'))
    expect(npmShimEntry(join(dir, 'plain.cmd'))).toBeNull()
    expect(npmShimEntry(join(dir, 'missing.cmd'))).toBeNull()
  })

  it('escapes arguments the way cross-spawn does', () => {
    // Arguments bound for a batch file are caret-escaped twice: cmd.exe parses
    // the line once to start the file and once more when the file expands %*.
    expect(escapeForCmd('plain', true)).toBe('^^^"plain^^^"')
    // Spaces are metacharacters to cmd.exe as well: pass one gives `^ `, pass
    // two escapes both the caret and the space again — `^^^ `.
    expect(escapeForCmd('a b', true)).toBe('^^^"a^^^ b^^^"')
    expect(escapeForCmd('say "hi"', true)).toBe('^^^"say^^^ \\^^^"hi\\^^^"^^^"')
    expect(escapeForCmd('C:\\dir\\', true)).toBe('^^^"C:\\dir\\\\^^^"')
    // The command path itself is parsed once, so a single caret does.
    expect(escapeForCmd('C:\\a(b)\\x.cmd', false)).toBe('C:\\a^(b^)\\x.cmd')
  })
})
