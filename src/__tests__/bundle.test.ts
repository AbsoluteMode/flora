import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installBundle, listInstalled, packWorkflow, readBundle, resolveWorkflowRef, unpackBundle } from '../bundle'
import { readZip, writeZip } from '../zip'

const run = promisify(execFile)

let dir: string
let home: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-bundle-'))
  home = join(dir, 'home')
  mkdirSync(home)
  process.env.FLORA_HOME = home
})
afterEach(() => {
  delete process.env.FLORA_HOME
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

/** The real CLI with flora's home (journal, library, bundle cache) inside the temp dir. */
const BIN = join(process.cwd(), 'bin', 'flora.mjs')
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const flora = (args: string[], cwd = process.cwd()) =>
  run(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, FLORA_HOME: home, FLORA_DB: join(home, 'flora.db') }
  }).then((r) => ({ ...r, stdout: plain(r.stdout) }))

/** A workflow folder: the yaml, a script it runs through {{workflow_dir}}, a prompt, and junk that must stay out. */
function project(): { root: string; workflow: string } {
  const root = join(dir, 'greeter')
  mkdirSync(join(root, 'prompts'), { recursive: true })
  mkdirSync(join(root, 'run', 'R1'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, 'hello.mjs'), `import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const prompt = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'hello.md'), 'utf8').trim()
console.log(JSON.stringify({ greeting: prompt.replace('{name}', process.argv[2]) }))`)
  writeFileSync(join(root, 'prompts', 'hello.md'), 'Привет, {name}!\n')
  writeFileSync(join(root, 'run', 'R1', 'big.jsonl'), 'run output that must not travel\n')
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(root, 'notes.log'), 'log\n')
  const workflow = join(root, 'greeter.yaml')
  writeFileSync(
    workflow,
    `name: greeter
version: 2
description: Says hello from a script that lives next to the workflow
params:
  who: { default: world, description: who to greet }
steps:
  - id: greet
    executor: { harness: command }
    run: node "{{workflow_dir}}/hello.mjs" {{who}}
    output: { type: json, schema: { type: object, required: [greeting] } }
    verify:
      - { type: command, run: node -e "process.exit(0)" }
`
  )
  return { root, workflow }
}

describe('zip', () => {
  it('round-trips entries, deflated or stored, with UTF-8 names and checksums', () => {
    const small = Buffer.from('x')
    const text = Buffer.from('flora '.repeat(500) + 'бандл')
    const archive = writeZip([
      { name: 'a/б.txt', data: text, mtime: new Date(2026, 8, 3, 12, 30, 10) },
      { name: 'tiny.bin', data: small }
    ])
    const entries = readZip(archive)
    expect(entries.map((e) => e.name)).toEqual(['a/б.txt', 'tiny.bin'])
    expect(entries[0].data.equals(text)).toBe(true)
    expect(entries[1].data.equals(small)).toBe(true)
    expect(entries[0].mtime?.getFullYear()).toBe(2026)
    expect(archive.length).toBeLessThan(text.length) // deflate did its job
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/not a zip/)
    // A stored one-byte entry: its data sits right after the 30-byte local header and the name.
    const corrupt = writeZip([{ name: 'tiny.bin', data: small }])
    corrupt[30 + 'tiny.bin'.length] ^= 0xff
    expect(() => readZip(corrupt)).toThrow(/checksum/)
  })
})

describe('pack', () => {
  it('takes the workflow folder, leaves out run output, dependencies, logs and journals', () => {
    const { root, workflow } = project()
    const result = packWorkflow(workflow, { floraVersion: '0.1.0' })
    expect(result.out).toBe(join(root, 'greeter.flora'))
    expect(result.manifest).toMatchObject({
      format: 1,
      name: 'greeter',
      version: 2,
      description: 'Says hello from a script that lives next to the workflow',
      workflow: 'greeter.yaml',
      params: { who: { default: 'world', description: 'who to greet' } },
      steps: [{ id: 'greet', harness: 'command' }],
      harnesses: ['command'],
      packed_with: 'flora 0.1.0'
    })
    expect(result.manifest.files.map((f) => f.path)).toEqual(['greeter.yaml', 'hello.mjs', 'prompts/hello.md'])
    expect(result.skipped.map((s) => s.path).sort()).toEqual(['node_modules', 'notes.log', 'run'])

    const bundle = readBundle(result.out)
    expect([...bundle.entries.keys()].sort()).toEqual(['greeter.yaml', 'hello.mjs', 'prompts/hello.md'])
    expect(bundle.entries.get('prompts/hello.md')?.toString()).toBe('Привет, {name}!\n')
  })

  it('--exclude and --include adjust the default rules', () => {
    const { workflow } = project()
    const result = packWorkflow(workflow, { exclude: ['prompts/**'], include: ['*.log'] })
    expect(result.manifest.files.map((f) => f.path)).toEqual(['greeter.yaml', 'hello.mjs', 'notes.log'])
  })

  it('a tampered bundle is refused, and so is a path that escapes the target', () => {
    const { workflow } = project()
    const { out } = packWorkflow(workflow)
    const entries = readZip(readFileSync(out))
    const script = entries.find((e) => e.name === 'hello.mjs')!
    script.data = Buffer.from('console.log("evil")')
    const tampered = join(dir, 'tampered.flora')
    writeFileSync(tampered, writeZip(entries))
    expect(() => readBundle(tampered)).toThrow(/does not match its checksum/)

    const bundle = readBundle(out)
    bundle.entries.set('../escape.txt', Buffer.from('x'))
    expect(() => unpackBundle(bundle, join(dir, 'unpack'))).toThrow(/unsafe path|outside the bundle directory/)
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
  })
})

describe('run, add, workflows through the CLI', () => {
  it('runs a bundle straight from the file, then by installed name', { timeout: 120_000 }, async () => {
    const { root, workflow } = project()
    const { stdout: packed } = await flora(['pack', workflow])
    expect(packed).toContain('greeter.flora')
    expect(packed).toContain('+ prompts/hello.md')
    const bundle = join(root, 'greeter.flora')

    // Somewhere else entirely, with only the bundle file at hand.
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    const { stdout: inspect } = await flora(['inspect', bundle], elsewhere)
    expect(inspect).toContain('greeter · v2')
    expect(inspect).toContain('who            default "world"  — who to greet')
    expect(inspect).toContain('needs: command')

    const { stdout: ran } = await flora(['run', bundle, '--param', 'who=Ada', '--cwd', elsewhere], elsewhere)
    expect(ran).toContain('bundle greeter →')
    expect(ran).toContain('run passed')
    const cached = join(home, 'bundles')
    expect(existsSync(cached)).toBe(true)

    const { stdout: added } = await flora(['add', bundle], elsewhere)
    expect(added).toContain('greeter installed')
    expect(existsSync(join(home, 'workflows', 'greeter', 'prompts', 'hello.md'))).toBe(true)
    await expect(flora(['add', bundle], elsewhere)).rejects.toMatchObject({ stderr: expect.stringContaining('already installed') })
    await flora(['add', bundle, '--force'], elsewhere)

    const { stdout: list } = await flora(['workflows'], elsewhere)
    expect(list).toContain('greeter')
    expect(list).toContain('Says hello')

    const { stdout: byName } = await flora(['run', 'greeter', '--cwd', elsewhere], elsewhere)
    expect(byName).toContain('installed greeter →')
    expect(byName).toContain('run passed')

    const { stdout: usage } = await flora(['runs'], elsewhere)
    expect(usage.split('\n').filter((l) => l.includes('greeter')).length).toBe(2)

    const { stdout: removed } = await flora(['remove', 'greeter'], elsewhere)
    expect(removed).toContain('removed')
    await expect(flora(['run', 'greeter'], elsewhere)).rejects.toMatchObject({ stderr: expect.stringContaining('no workflow file, bundle or installed workflow "greeter"') })
  })

  it('resolves refs: a file as is, a name from the library', () => {
    const { workflow } = project()
    expect(resolveWorkflowRef(workflow)).toEqual({ workflow, kind: 'file' })
    const { out } = packWorkflow(workflow)
    installBundle(out)
    expect(listInstalled().map((i) => i.name)).toEqual(['greeter'])
    expect(resolveWorkflowRef('greeter').kind).toBe('installed')
    expect(() => resolveWorkflowRef('nope')).toThrow(/installed: greeter/)
  })
})
