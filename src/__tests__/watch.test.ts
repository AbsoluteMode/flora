import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schemaErrors } from '../contract'
import { nextCron, parseCron } from '../cron'
import { RunStore } from '../state'
import { backoffMs, pollCommand, pollSentry, type TriggerEvent } from '../triggers'
import { discoverWorkflows, Watcher } from '../watch'
import { validateWorkflow, WorkflowError } from '../workflow'
import type { RunRecord, WorkflowSpec } from '../types'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flora-watch-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const local = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min, 0, 0)

describe('cron parser', () => {
  it('reads the common forms', () => {
    expect([...parseCron('*/15 * * * *').minute]).toEqual([0, 15, 30, 45])
    const weekdays = parseCron('0 9 * * 1-5')
    expect([...weekdays.hour]).toEqual([9])
    expect([...weekdays.dayOfWeek]).toEqual([1, 2, 3, 4, 5])
    expect(weekdays.anyDayOfMonth).toBe(true)
    expect([...parseCron('30 2 1,15 * *').dayOfMonth]).toEqual([1, 15])
    expect(parseCron('0 0 * * 7').dayOfWeek.has(0)).toBe(true)
    expect([...parseCron('1-10/3 * * * *').minute]).toEqual([1, 4, 7, 10])
  })

  it.each(['60 * * * *', '* * * *', 'a b c d e', '*/0 * * * *', '5-3 * * * *', '0 0 32 * *'])('refuses "%s"', (expr) => {
    expect(() => parseCron(expr)).toThrow(/cron/)
  })

  it('finds the next occurrence, including the cron OR rule for day fields', () => {
    expect(nextCron(parseCron('*/15 * * * *'), local(2026, 9, 2, 10, 7))).toEqual(local(2026, 9, 2, 10, 15))
    // Saturday → Monday 09:00.
    expect(nextCron(parseCron('0 9 * * 1-5'), local(2026, 9, 5, 12, 0))).toEqual(local(2026, 9, 7, 9, 0))
    expect(nextCron(parseCron('30 2 1,15 * *'), local(2026, 9, 20, 0, 0))).toEqual(local(2026, 10, 1, 2, 30))
    // Both day fields set: the 13th OR a Friday, whichever comes first (Sep 4 2026 is a Friday).
    expect(nextCron(parseCron('0 0 13 * 5'), local(2026, 9, 2, 0, 0))).toEqual(local(2026, 9, 4, 0, 0))
    // Strictly after `from`.
    expect(nextCron(parseCron('0 * * * *'), local(2026, 9, 2, 10, 0))).toEqual(local(2026, 9, 2, 11, 0))
    expect(() => nextCron(parseCron('0 0 31 2 *'), local(2026, 1, 1))).toThrow(/never fires/)
  })
})

describe('event sources', () => {
  it('command: JSON lines are events, text is one event, silence is none, a failure throws', async () => {
    const lines = await pollCommand(
      { run: `node -e "console.log(JSON.stringify({ id: 'a', n: 1 })); console.log(JSON.stringify({ n: 2 }))"` },
      dir
    )
    expect(lines.map((e) => e.source)).toEqual(['command', 'command'])
    expect(lines[0]).toMatchObject({ id: 'a', n: 1 })
    expect(lines[1].n).toBe(2)
    expect(lines[1].id).toMatch(/^[0-9a-f]{32}$/)

    const text = await pollCommand({ run: 'echo hello' }, dir)
    expect(text).toHaveLength(1)
    expect(text[0].text).toBe('hello')

    expect(await pollCommand({ run: 'node -e ""' }, dir)).toEqual([])
    await expect(pollCommand({ run: 'node -e "process.exit(3)"' }, dir)).rejects.toThrow(/exited 3/)
  })

  it('backs off exponentially up to fifteen minutes', () => {
    expect(backoffMs(60_000, 0)).toBe(60_000)
    expect(backoffMs(60_000, 3)).toBe(480_000)
    expect(backoffMs(60_000, 10)).toBe(900_000)
  })

  describe('sentry', () => {
    let server: Server
    let url: string
    let seenAuth: string | undefined
    let status = 200

    beforeEach(async () => {
      status = 200
      server = createServer((req, res) => {
        seenAuth = req.headers.authorization
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(
          req.url?.startsWith('/api/0/projects/my-org/backend/issues/')
            ? JSON.stringify([
                { id: '101', title: 'TimeoutError: worker gave up', permalink: 'https://s/101', level: 'error', count: '7' },
                { id: '102', title: 'TypeError: x is not a function', permalink: 'https://s/102' }
              ])
            : '[]'
        )
      })
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
      const address = server.address() as { port: number }
      url = `http://127.0.0.1:${address.port}`
      process.env.SENTRY_AUTH_TOKEN = 'test-token'
    })

    afterEach(async () => {
      delete process.env.SENTRY_AUTH_TOKEN
      await new Promise<void>((ok) => server.close(() => ok()))
    })

    it('polls the project, matches by regexp, sends the token from the environment', async () => {
      const events = await pollSentry({ org: 'my-org', project: 'backend', query: 'is:unresolved', match: 'Timeout', url })
      expect(seenAuth).toBe('Bearer test-token')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ source: 'sentry', id: '101', title: 'TimeoutError: worker gave up', url: 'https://s/101', count: 7 })
    })

    it('fails loudly on a bad status or a missing token', async () => {
      status = 500
      await expect(pollSentry({ org: 'my-org', project: 'backend', url })).rejects.toThrow(/500/)
      delete process.env.SENTRY_AUTH_TOKEN
      await expect(pollSentry({ org: 'my-org', project: 'backend', url })).rejects.toThrow(/SENTRY_AUTH_TOKEN/)
    })
  })
})

describe('dedup journal', () => {
  it('claims an event once per workflow, and forgets old claims', () => {
    const store = new RunStore(join(dir, 'flora.db'))
    expect(store.markSeen('sentry', '101', 'triage')).toBe(true)
    expect(store.markSeen('sentry', '101', 'triage')).toBe(false)
    expect(store.markSeen('sentry', '101', 'other-workflow')).toBe(true)
    expect(store.pruneSeen(30)).toBe(0)
    expect(store.pruneSeen(0)).toBe(2)
    expect(store.markSeen('sentry', '101', 'triage')).toBe(true)
    store.close()
  })
})

describe('trigger validation', () => {
  const withOn = (on: unknown): WorkflowSpec =>
    ({ name: 'w', on, steps: [{ id: 'a', executor: { harness: 'command' }, run: 'x' }] }) as WorkflowSpec

  // `codeOnly`: a JSON Schema can check the shape of a cron expression or a
  // regexp, not whether it means anything — the code validator does that.
  const cases: Array<[string, unknown, RegExp, boolean?]> = [
    ['a broken cron', { cron: '99 * * * *' }, /cron/, true],
    ['a cron with the wrong number of fields', { cron: '* * * *' }, /cron/],
    ['sentry without org', { sentry: { project: 'p' } }, /org is required/],
    ['sentry with a bad regexp', { sentry: { org: 'o', project: 'p', match: '(' } }, /regular expression/, true],
    ['a command polling too often', { command: { run: 'x', interval_sec: 0 } }, /interval_sec/],
    ['event data in a shell line', { command: { run: 'echo {{event.id}}' } }, /not allowed/],
    ['an unknown source', { webhook: {} }, /unknown field "webhook"/],
    ['no source at all', {}, /at least one source/]
  ]
  it.each(cases)('refuses %s', (_name, on, message, codeOnly) => {
    const spec = withOn(on)
    expect(() => validateWorkflow(spec)).toThrow(message)
    expect(() => validateWorkflow(spec)).toThrow(WorkflowError)
    if (!codeOnly) expect(schemaErrors(spec).length).toBeGreaterThan(0)
  })

  it('keeps {{event.*}} out of step shell lines too, but welcomes it in prompts and expectations', () => {
    const bad = { name: 'w', on: { cron: '* * * * *' }, steps: [{ id: 'a', executor: { harness: 'command' }, run: 'echo {{event.text}}' }] } as WorkflowSpec
    expect(() => validateWorkflow(bad)).toThrow(/event/)
    const good = {
      name: 'w',
      on: { cron: '* * * * *' },
      steps: [{ id: 'a', executor: { harness: 'claude-code' }, prompt: 'look at {{event.title}}', verify: [{ type: 'command', run: 'echo', expect_match: '{{event.id}}' }] }]
    } as WorkflowSpec
    expect(() => validateWorkflow(good)).not.toThrow()
    expect(schemaErrors(good)).toEqual([])
  })
})

const cronWorkflow = (name: string, cron: string): string =>
  `name: ${name}\non:\n  cron: '${cron}'\nsteps:\n  - id: a\n    executor: { harness: command }\n    run: echo tick\n`

const fakeRecord = (status: RunRecord['status'] = 'passed'): RunRecord => ({
  runId: `r-${Math.random().toString(16).slice(2)}`,
  workflow: 'w',
  cwd: '/',
  params: {},
  status,
  startedAt: new Date().toISOString(),
  steps: []
})

describe('watcher', () => {
  it('discovers only workflows with an on: block, recursively', () => {
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'a.yaml'), cronWorkflow('a', '0 * * * *'))
    writeFileSync(join(dir, 'nested', 'b.yaml'), cronWorkflow('b', '*/5 * * * *'))
    writeFileSync(join(dir, 'plain.yaml'), 'name: plain\nsteps:\n  - id: a\n    executor: { harness: command }\n    run: echo\n')
    expect(discoverWorkflows([dir]).map((w) => w.spec.name)).toEqual(['a', 'b'])
    expect(discoverWorkflows([join(dir, 'plain.yaml')])).toEqual([])
  })

  it('fires a cron schedule on time: 24 hourly ticks in a virtual day, each a distinct event', async () => {
    vi.useFakeTimers({ now: local(2026, 9, 2, 0, 0) })
    writeFileSync(join(dir, 'hourly.yaml'), cronWorkflow('hourly', '0 * * * *'))
    const store = new RunStore(join(dir, 'flora.db'))
    const fired: TriggerEvent[] = []
    const watcher = new Watcher({
      paths: [dir],
      cwd: dir,
      store,
      log: () => {},
      runner: async (_wf, event) => {
        fired.push(event)
        return fakeRecord()
      }
    })
    watcher.start()
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000)
    expect(fired).toHaveLength(24)
    expect(fired.every((e) => e.source === 'cron')).toBe(true)
    expect(new Set(fired.map((e) => e.id)).size).toBe(24)
    await watcher.stop()
    store.close()
  }, 30_000)

  it('skips a cron tick while a run is in progress instead of piling up', async () => {
    vi.useFakeTimers({ now: local(2026, 9, 2, 0, 30) })
    writeFileSync(join(dir, 'hourly.yaml'), cronWorkflow('hourly', '0 * * * *'))
    const store = new RunStore(join(dir, 'flora.db'))
    let release: () => void = () => {}
    let calls = 0
    const skipped: string[] = []
    const watcher = new Watcher({
      paths: [dir],
      cwd: dir,
      store,
      log: (line) => {
        if (line.includes('skipped')) skipped.push(line)
      },
      runner: () =>
        new Promise((ok) => {
          calls++
          release = () => ok(fakeRecord())
        })
    })
    watcher.start()
    await vi.advanceTimersByTimeAsync(2 * 3600 * 1000) // 01:00 starts a run, 02:00 lands on it
    expect(calls).toBe(1)
    expect(skipped).toHaveLength(1)
    release()
    await vi.advanceTimersByTimeAsync(3600 * 1000) // 03:00 runs again
    expect(calls).toBe(2)
    release()
    await watcher.stop()
    store.close()
  }, 30_000)

  it('queues events that arrive during a run and drains the queue afterwards', async () => {
    writeFileSync(
      join(dir, 'poll.yaml'),
      `name: poll\non:\n  command:\n    run: 'node -e "console.log(JSON.stringify({ id: 1 })); console.log(JSON.stringify({ id: 2 }))"'\n    interval_sec: 3600\nsteps:\n  - id: a\n    executor: { harness: command }\n    run: echo\n`
    )
    const store = new RunStore(join(dir, 'flora.db'))
    const started: string[] = []
    const releases: Array<() => void> = []
    const watcher = new Watcher({
      paths: [dir],
      cwd: dir,
      store,
      log: () => {},
      runner: (_wf, event) =>
        new Promise((ok) => {
          started.push(event.id)
          releases.push(() => ok(fakeRecord()))
        })
    })
    watcher.start()
    await vi.waitFor(() => expect(started).toEqual(['1']), { timeout: 10_000 })
    releases[0]()
    await vi.waitFor(() => expect(started).toEqual(['1', '2']), { timeout: 10_000 })
    releases[1]()
    await watcher.stop()
    store.close()
  })

  it('--once: polls, runs the real engine with the event in context, and never fires the same event twice', async () => {
    writeFileSync(
      join(dir, 'inbox.yaml'),
      [
        'name: inbox',
        'on:',
        `  command: { run: 'node -e "console.log(JSON.stringify({ id: ''e1'', text: ''ping'' }))"', interval_sec: 60 }`,
        'steps:',
        '  - id: echo',
        '    executor: { harness: command }',
        `    run: 'node -e "console.log(require(process.env.FLORA_CONTEXT).event.text)"'`,
        '    verify:',
        '      - type: command',
        `        run: 'node -e "console.log(require(process.env.FLORA_CONTEXT).event.text)"'`,
        `        expect_match: '{{event.text}}'`,
        ''
      ].join('\n')
    )
    const store = new RunStore(join(dir, 'flora.db'))
    const watcher = new Watcher({ paths: [dir], cwd: dir, store, log: () => {} })
    expect(await watcher.once()).toBe(1)

    const [summary] = store.list()
    const record = store.load(summary.runId)!
    expect(record.status).toBe('passed')
    expect(record.trigger).toEqual({ source: 'command', id: 'e1' })
    expect(record.steps[0].evidence?.output).toBe('ping')

    expect(await watcher.once()).toBe(0)
    await watcher.stop()
    store.close()
  }, 30_000)
})
