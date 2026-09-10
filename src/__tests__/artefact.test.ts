import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRunFile } from '../runfile'
import { RunStore } from '../state'
import { startServer, type RunningServer } from '../web/server'
import type { RunRecord } from '../types'

const run = promisify(execFile)
const BIN = join(process.cwd(), 'bin', 'flora.mjs')
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

let dir: string
let home: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-artefact-'))
  home = join(dir, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

const flora = (args: string[], h = home) =>
  run(process.execPath, [BIN, ...args], { cwd: dir, env: { ...process.env, FLORA_HOME: h, FLORA_DB: join(h, 'flora.db') } }).then((r) => ({ ...r, stdout: plain(r.stdout) }))

const get = (url: string) =>
  new Promise<{ status: number; type: string; body: string }>((ok, fail) => {
    request(url, (r) => {
      let body = ''
      r.on('data', (c) => (body += c))
      r.on('end', () => ok({ status: r.statusCode ?? 0, type: String(r.headers['content-type']), body }))
    })
      .on('error', fail)
      .end()
  })

describe('the run as an artefact', () => {
  it('keeps the command as run and the files a step declares; the viewer serves them, export carries them, import restores them', { timeout: 120_000 }, async () => {
    const script = join(dir, 'stage.mjs')
    writeFileSync(
      script,
      `import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('traces/02', { recursive: true })
writeFileSync('traces/02/P_001.prompt.md', '# task\\nfilter this post')
writeFileSync('traces/02/P_001.reply.md', '{"category":"example category"}')
writeFileSync('calls.jsonl', '{"tag":"02:P_001","usage":{"cost":0.01}}\\n')
console.log(JSON.stringify({ ok: true, metrics: { in: 1, out: 1 }, artifacts: ['calls.jsonl', 'traces/02', 'missing.txt'] }))`
    )
    const workflow = join(dir, 'flow.yaml')
    writeFileSync(
      workflow,
      `name: artefact
params:
  who: { default: ada }
steps:
  - id: filter
    executor: { harness: command }
    run: node "${script.replace(/\\/g, '/')}" {{who}}
    output: { type: json, schema: { type: object, required: [ok] } }
`
    )
    const { stdout: ran } = await flora(['run', workflow, '--cwd', dir])
    expect(ran).toContain('run passed')

    const store = new RunStore(join(home, 'flora.db'))
    const record = store.list(1).map((r) => store.load(r.runId))[0] as RunRecord
    store.close()
    const step = record.steps[0]
    expect(step.command).toBe(`node "${script.replace(/\\/g, '/')}" ada`)
    expect(step.prompt).toBeUndefined()
    expect(step.artifacts?.map((a) => a.path).sort()).toEqual(['filter/calls.jsonl', 'filter/traces/02/P_001.prompt.md', 'filter/traces/02/P_001.reply.md'])
    expect(step.artifacts?.find((a) => a.path === 'filter/calls.jsonl')).toMatchObject({ source: 'calls.jsonl', bytes: 41 })
    const copied = join(home, 'runs', record.runId, 'artifacts', 'filter', 'traces', '02', 'P_001.prompt.md')
    expect(readFileSync(copied, 'utf8')).toContain('filter this post')

    // The viewer hands the file over as text, and refuses what was not declared.
    const server: RunningServer = await startServer({ port: 0, dbPath: join(home, 'flora.db') })
    try {
      const ok = await get(`${server.url}/api/runs/${record.runId}/artifacts/filter/traces/02/P_001.reply.md`)
      expect(ok.status).toBe(200)
      expect(ok.type).toContain('text/plain')
      expect(ok.body).toContain('example category')
      const nope = await get(`${server.url}/api/runs/${record.runId}/artifacts/filter/../../../flora.db`)
      expect(nope.status).toBe(404)
      const undeclared = await get(`${server.url}/api/runs/${record.runId}/artifacts/filter/other.txt`)
      expect(undeclared.status).toBe(404)
    } finally {
      await server.close()
    }

    // The report names them; the export carries them; an import restores them elsewhere.
    const { stdout: report } = await flora(['report', record.runId])
    expect(report).toContain('Command (as run):')
    expect(report).toContain('- `filter/traces/02/P_001.prompt.md`')

    const out = join(dir, 'artefact.flora-run')
    const { stdout: exported } = await flora(['export', record.runId, '--out', out])
    expect(exported).toContain('3 artifact files')
    const file = readRunFile(out)
    expect(file.artifacts.map((a) => a.path).sort()).toEqual(['filter/calls.jsonl', 'filter/traces/02/P_001.prompt.md', 'filter/traces/02/P_001.reply.md'])

    const other = join(dir, 'other')
    mkdirSync(other)
    const { stdout: imported } = await flora(['import', out], other)
    expect(imported).toContain('3 artifact files')
    expect(existsSync(join(other, 'runs', record.runId, 'artifacts', 'filter', 'calls.jsonl'))).toBe(true)
  })
})
