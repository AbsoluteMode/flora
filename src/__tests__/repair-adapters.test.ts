import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWorkflow } from '../engine'
import { createRecorder } from '../recorder'
import { RunStore } from '../state'
import { ANTIGRAVITY_SETTINGS, antigravityAdapter } from '../adapters/antigravity'
import { CLAUDE_REPAIR_DENIED_TOOLS, claudeCodeAdapter, claudeRepairArgs } from '../adapters/claude-code'
import { codexAdapter, codexRepairArgs, withoutAccessFlags } from '../adapters/codex'
import { OUTPUT_INSTRUCTION } from '../output'
import type { StepSpec } from '../types'

/**
 * Stand-ins for `claude`, `codex` and `agy` — never the real CLIs. Each call
 * is appended to $FAKE_LOG with its argv. The first answer of a step breaks
 * the schema (lists where strings are declared, the live case); an answer in
 * a continued session (`--resume`, `exec … resume`, `--conversation`) is
 * correct. So a passing step proves the repair went into the same session,
 * and the log proves the work itself ran once.
 */
const FIXTURE = `import fs from 'node:fs';
const [name, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, args }) + '\\n');
const LISTS = '\`\`\`json\\n{"changes":["a.ts"],"checks":["npm test"]}\\n\`\`\`';
const STRINGS = '\`\`\`json\\n{"changes":"a.ts","checks":"npm test"}\\n\`\`\`';
const resumed = (name === 'claude' && args.includes('--resume')) || (name === 'codex' && args.includes('resume')) || (name === 'agy' && args.includes('--conversation'));
const text = resumed || process.env.FAKE_ALWAYS_RIGHT ? STRINGS : LISTS;
if (name === 'claude') {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session-1' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: resumed ? 0.01 : 0.2, session_id: 'claude-session-1', usage: { input_tokens: 10, output_tokens: 5 } }));
} else if (name === 'codex') {
  if (args[0] === 'mcp') { console.log(JSON.stringify([{ name: 'personal', transport: { type: 'stdio', command: 'node' } }])); process.exit(0) }
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
} else {
  if (args[0] === 'models') { console.log('gemini-4-carbon-medium\\tGemini 4 Carbon (Medium)'); process.exit(0) }
  const id = 'agy-conversation-1';
  console.log(JSON.stringify({ event: 'init', conversation_id: id, init: { model: args[args.indexOf('--model') + 1] } }));
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }));
}
`

const SCHEMA = {
  type: 'object',
  required: ['changes', 'checks'],
  properties: { changes: { type: 'string' }, checks: { type: 'string' } }
}

let dir: string
let bin: string
let log: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'flora-repair-cli-')))
  bin = join(dir, 'bin')
  mkdirSync(bin)
  log = join(dir, 'calls.jsonl')
  writeFileSync(join(dir, 'fixture.mjs'), FIXTURE)
  for (const name of ['claude', 'codex', 'agy']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fixture.mjs')}" ${name} "$@"\n`)
    chmodSync(join(bin, name), 0o755)
  }
  vi.stubEnv('PATH', bin + delimiter + (process.env.PATH ?? ''))
  vi.stubEnv('FAKE_LOG', log)
  vi.stubEnv('FLORA_HOME', join(dir, 'home'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

const calls = (): Array<{ name: string; args: string[] }> =>
  readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
/** The model calls only — not `codex mcp list` or `agy models`. */
const turns = () => calls().filter((c) => c.args[0] !== 'mcp' && c.args[0] !== 'models')
const occurrences = (text: string, part: string): number => text.split(part).length - 1

const STEPS: Record<string, StepSpec> = {
  'claude-code': { id: 'work', executor: { harness: 'claude-code', model: 'opus' }, prompt: 'Do the work', output: { type: 'json', schema: SCHEMA } },
  codex: {
    id: 'work',
    executor: { harness: 'codex', args: ['--skip-git-repo-check', '--full-auto', '-s', 'workspace-write'] },
    prompt: 'Do the work',
    output: { type: 'json', schema: SCHEMA }
  },
  antigravity: { id: 'work', executor: { harness: 'antigravity', access: 'write' }, prompt: 'Do the work', output: { type: 'json', schema: SCHEMA } }
}

describe('output repair through the real adapters, stand-in CLIs', () => {
  it.each(Object.keys(STEPS))('%s: the schema reaches the agent, the repair continues its session read-only, the work runs once', async (harness) => {
    const record = await runWorkflow({ name: 'repair', steps: [STEPS[harness]] }, { cwd: dir })

    expect(record.status).toBe('passed')
    expect(record.steps[0].output).toEqual({ changes: 'a.ts', checks: 'npm test' })
    expect(record.steps[0].outputRepairs).toEqual([expect.objectContaining({ repair: 1, mode: 'resume', status: 'passed' })])

    const [work, repair, ...rest] = turns()
    expect(rest).toEqual([])
    // The step's prompt carries the instruction and the schema itself.
    const workPrompt = work.args.at(-1)!
    expect(workPrompt.startsWith('Do the work')).toBe(true)
    expect(workPrompt).toContain(OUTPUT_INSTRUCTION)
    expect(workPrompt).toContain('must match this JSON Schema')
    expect(workPrompt).toContain(JSON.stringify(SCHEMA, null, 2))
    // The repair message goes as is: one output instruction, the errors, the schema.
    const repairPrompt = repair.args.at(-1)!
    expect(occurrences(repairPrompt, OUTPUT_INSTRUCTION)).toBe(1)
    expect(repairPrompt).toContain('- /changes: must be string')
    expect(repairPrompt).toContain('Do not redo the work, do not change files')
    expect(repairPrompt).toContain(JSON.stringify(SCHEMA, null, 2))

    if (harness === 'claude-code') {
      expect(record.steps[0].evidence?.sessionId).toBe('claude-session-1')
      expect(repair.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--model', 'opus',
        '--disallowedTools', CLAUDE_REPAIR_DENIED_TOOLS.join(','), '--resume', 'claude-session-1', '--', repairPrompt])
      // Both calls were paid for.
      expect(record.steps[0].evidence?.costUsd).toBeCloseTo(0.21)
    }
    if (harness === 'codex') {
      expect(record.steps[0].evidence?.sessionId).toBe('codex-thread-1')
      expect(work.args).toEqual(expect.arrayContaining(['--full-auto', 'workspace-write']))
      expect(repair.args).toEqual(['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only',
        '-c', 'mcp_servers={"personal"={command="node",enabled=false}}', 'resume', 'codex-thread-1', repairPrompt])
      expect(record.steps[0].evidence?.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 })
    }
    if (harness === 'antigravity') {
      expect(record.steps[0].evidence?.sessionId).toBe('agy-conversation-1')
      expect(work.args).toContain('--mode')
      expect(repair.args).not.toContain('--mode')
      expect(JSON.parse(repair.args[repair.args.indexOf('--settings') + 1])).toEqual(ANTIGRAVITY_SETTINGS.read)
      expect(repair.args.slice(-4)).toEqual(['--conversation', 'agy-conversation-1', '--print', repairPrompt])
      expect(record.steps[0].evidence?.usage).toMatchObject({ totalTokens: 30 })
    }
  })

  it('an answer that is right the first time costs no repair', async () => {
    vi.stubEnv('FAKE_ALWAYS_RIGHT', '1')
    const record = await runWorkflow({ name: 'clean', steps: [STEPS.codex] }, { cwd: dir })
    expect(record.status).toBe('passed')
    expect(record.steps[0].outputRepairs).toBeUndefined()
    expect(turns()).toHaveLength(1)
  })

  it('the journal keeps the repair: events with attempt, errors and duration, and the step record', async () => {
    const store = new RunStore(join(dir, 'flora.db'))
    const recorder = createRecorder(store, { cwd: dir, params: {} })
    try {
      const record = await runWorkflow({ name: 'journal', steps: [STEPS.codex] }, { cwd: dir, onEvent: (e) => recorder.write(e) })
      recorder.close()
      const rows = store.readEvents(record.runId).filter((e) => e.type.startsWith('output_repair'))
      expect(rows.map((e) => e.type)).toEqual(['output_repair_start', 'output_repair_result'])
      expect(rows[0].payload).toMatchObject({
        stepId: 'work', attempt: 1, repair: 1, maxRepairs: 2, mode: 'resume', sessionId: 'codex-thread-1',
        errors: [{ path: '/changes', message: 'must be string' }, { path: '/checks', message: 'must be string' }]
      })
      expect(rows[1].payload).toMatchObject({ stepId: 'work', attempt: 1, repair: 1, status: 'passed', exitCode: 0, durationMs: expect.any(Number) })
      const saved = store.load(record.runId)!
      expect(saved.steps[0].outputRepairs?.[0]).toMatchObject({ mode: 'resume', status: 'passed', sessionId: 'codex-thread-1' })
    } finally { recorder.close(); store.close() }
  })
})

describe('repair command lines', () => {
  const input = (harness: string, extra: Record<string, unknown> = {}) => ({ spec: { harness }, prompt: 'Fix the form', cwd: '/w', ...extra })

  it('claude-code: --resume only with a known, well-formed session id', () => {
    expect(claudeRepairArgs(input('claude-code'))).not.toContain('--resume')
    expect(claudeRepairArgs(input('claude-code', { sessionId: '-rf' }))).not.toContain('--resume')
    expect(claudeRepairArgs(input('claude-code', { sessionId: 'abc-1' })).slice(-4)).toEqual(['--resume', 'abc-1', '--', 'Fix the form'])
    // No MCP servers at all for a repair.
    expect(claudeRepairArgs(input('claude-code', { sessionId: 'abc-1' }))).not.toContain('--mcp-config')
  })

  it('codex: a fresh repair is a plain read-only exec; the step\'s sandbox and approval flags are dropped', () => {
    expect(codexRepairArgs(input('codex'))).toEqual(['exec', '--json', '--sandbox', 'read-only', '--', 'Fix the form'])
    expect(withoutAccessFlags(['--skip-git-repo-check', '--sandbox=danger-full-access', '-sworkspace-write', '--yolo', '--dangerously-bypass-approvals-and-sandbox', '-c', 'x=1', '--full-auto', '--sandbox', 'workspace-write']))
      .toEqual(['--skip-git-repo-check', '-c', 'x=1'])
  })

  it('every resuming adapter offers a repair route', () => {
    expect(typeof claudeCodeAdapter.repair).toBe('function')
    expect(typeof codexAdapter.repair).toBe('function')
    expect(typeof antigravityAdapter.repair).toBe('function')
  })
})
