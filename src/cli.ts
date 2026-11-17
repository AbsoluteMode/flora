// Best-effort: bin/flora.mjs is what actually guarantees the filter is in
// place before `node:sqlite` loads; this covers direct `tsx src/cli.ts` use.
import './warnings'
import { constants as osConstants } from 'node:os'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'
import { runWorkflow } from './engine'
import { RunStore } from './state'
import { createRecorder } from './recorder'
import { loadWorkflow, WorkflowError } from './workflow'
import { DEFAULT_PORT, startServer, type RunningServer } from './web/server'
import { serveMcp, type McpServerOptions } from './mcp/server'
import { Watcher } from './watch'
import { doctor, formatProbes } from './doctor'
import { gateInstall, gateStatus, gateUninstall } from './gate'
import { formatCost, formatTokens, formatUsageTable, runUsage } from './usage'
import { describeBundle, formatBytes, installBundle, isBundlePath, libraryDir, listInstalled, packWorkflow, readBundle, removeInstalled, resolveWorkflowRef } from './bundle'
import { renderRunReport } from './report'
import { analyticsRows, formatAnalyticsTable, formatRunsAnalytics, runAnalytics, toCsv } from './analytics'
import { exportRun, importRun, isRunFilePath, readRunFile, writeRunArtifacts } from './runfile'
import { openInBrowser } from './browser'
import { floraVersion as version } from './version'
import type { RunEvent, RunRecord, RunSummary } from './types'
import { connectionConfig } from './connect'

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Map<string, string[]> } {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : ''
  const rest = command ? argv.slice(1) : argv
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = rest[i + 1]
      const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true'
      flags.set(name, [...(flags.get(name) ?? []), value])
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}

function renderEvent(event: RunEvent): void {
  switch (event.type) {
    case 'run_start':
      console.log(dim(`run ${event.runId} · ${event.workflow} · ${event.steps} steps\n`))
      break
    case 'step_start':
      console.log(
        `${bold(`▶ ${event.stepId}`)}${event.title ? ` — ${event.title}` : ''} ` +
          dim(`[${event.harness}${Number(event.maxAttempts) > 1 ? ` · attempt ${event.attempt}/${event.maxAttempts}` : ''}]`)
      )
      break
    case 'step_verifying':
      if (Number(event.checks) > 0) console.log(dim(`  verifying (${event.checks} checks)…`))
      break
    case 'check_result':
      console.log(event.passed ? dim(`  ✓ ${event.detail}`) : red(`  ✗ ${event.detail}`))
      break
    case 'step_result':
      if (event.error) console.log(red(`  ✗ ${event.error}`))
      console.log(event.status === 'passed' ? green(`  passed`) : red(`  failed`))
      break
    case 'step_skipped':
      console.log(`${bold(`– ${event.stepId}`)}${event.title ? ` — ${event.title}` : ''} ${dim(`skipped (when: ${event.when})`)}`)
      break
    case 'branch_start':
      console.log(dim(`  ├ branch ${event.branch}${event.title ? ` — ${event.title}` : ''} [${event.harness}]`))
      break
    case 'branch_result':
      console.log(
        event.status === 'passed'
          ? dim(`  ├ branch ${event.branch} passed${event.patch ? ` · patch ${event.patch}` : ''}`)
          : red(`  ├ branch ${event.branch} failed`)
      )
      break
    case 'output_repair_start':
      console.log(
        dim(`  ↻ output repair ${event.repair}/${event.maxRepairs}${event.branch !== undefined ? ` (branch ${event.branch})` : ''} · ${event.mode === 'resume' ? 'same session' : 'new request'} · ${event.error}`)
      )
      break
    case 'output_repair_result':
      console.log(
        event.status === 'passed'
          ? dim(`  ↻ output repaired (${event.durationMs}ms)`)
          : dim(`  ↻ output repair ${event.repair} did not fix it${event.error ? `: ${event.error}` : ''}`)
      )
      break
    case 'run_end':
      console.log(
        `\n${event.status === 'passed' ? green(`✓ run passed`) : red(`✗ run ${event.status}`)}` +
          (event.failedStep ? dim(` (step ${event.failedStep})`) : '')
      )
      break
    default:
      break
  }
}

/** `--param name=value`, repeatable. */
function parseParams(flags: Map<string, string[]>): Record<string, string> {
  const params: Record<string, string> = Object.create(null)
  for (const pair of flags.get('param') ?? []) {
    const eq = pair.indexOf('=')
    if (eq < 0) throw new WorkflowError(`--param expects name=value, got "${pair}"`)
    params[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return params
}

async function commandRun(positional: string[], flags: Map<string, string[]>): Promise<void> {
  const ref = positional[0]
  if (!ref) {
    printUsage()
    process.exit(1)
  }
  // A workflow file, a .flora bundle (unpacked into flora's cache), or an
  // installed workflow by name — the run itself does not care which.
  const target = resolveWorkflowRef(ref)
  const file = target.workflow
  if (target.kind !== 'file') console.log(dim(`${target.kind === 'bundle' ? 'bundle' : 'installed'} ${target.manifest?.name ?? ref} → ${file}\n`))
  const spec = loadWorkflow(file)
  const params = parseParams(flags)
  const cwd = resolve(flags.get('cwd')?.[0] ?? process.cwd())

  const abort = new AbortController()
  onStopSignal(() => abort.abort())

  // The recorder mirrors the engine's events into the journal so `flora serve`
  // can follow this run from another process. The engine itself stays unaware
  // of storage — it just calls onEvent.
  const store = new RunStore()
  // Runs whose flora died earlier stop pretending to be alive before a new one starts.
  store.sweepInterrupted()
  const recorder = createRecorder(store, { cwd, params })
  let record: RunRecord
  try {
    record = await runWorkflow(spec, {
      cwd,
      params,
      source: resolve(file),
      signal: abort.signal,
      onEvent: (event) => {
        renderEvent(event)
        recorder.write(event)
      }
    })
    // Preserve the returned record for callers without a live recorder too.
    store.save(record)
  } finally {
    try { recorder.close() } finally { store.close() }
  }
  // And the same run as files: run.json + report.md next to the run's
  // artifacts, plus wherever --report points — something to open or send.
  const artifacts = writeRunArtifacts(record, { version: version() })
  console.log(dim(`report ${artifacts.report}`))
  const reportTo = flags.get('report')?.[0]
  if (reportTo) {
    // A path without an extension is a folder (created if needed); anything
    // else is the file to write.
    const target = resolve(reportTo)
    const isDir = existsSync(target) ? statSync(target).isDirectory() : extname(target) === ''
    const path = isDir ? join(target, `${record.workflow.replace(/[^A-Za-z0-9._-]+/g, '-')}-${record.runId.slice(0, 8)}.md`) : target
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(artifacts.report, path)
    console.log(dim(`report ${path}`))
  }
  process.exit(record.status === 'passed' ? 0 : 1)
}

/**
 * `flora analytics [run-id] [--json] [--csv [file]] [--all [--workflow name] [--limit n]]`
 * — what went in, what came out, what it cost, per step; across runs with --all.
 */
function commandAnalytics(positional: string[], flags: Map<string, string[]>): void {
  const store = new RunStore()
  try {
    store.sweepInterrupted()
    const csvTo = flags.get('csv')?.[0]
    const writeCsv = (rows: ReturnType<typeof analyticsRows>): void => {
      const text = toCsv(rows)
      if (csvTo && csvTo !== 'true') {
        writeFileSync(resolve(csvTo), text)
        console.log(`${green('✓')} ${resolve(csvTo)} ${dim(`(${rows.length} rows)`)}`)
      } else process.stdout.write(text)
    }
    if (flags.has('all')) {
      const limit = Number(flags.get('limit')?.[0] ?? 50)
      const only = flags.get('workflow')?.[0]
      const records = store
        .list(Number.isFinite(limit) ? limit : 50)
        .filter((r) => !only || r.workflow === only)
        .map((r) => store.load(r.runId))
        .filter((r): r is RunRecord => r !== null)
      if (flags.has('csv')) return writeCsv(analyticsRows(records))
      const list = records.map(runAnalytics)
      if (flags.has('json')) {
        console.log(JSON.stringify(list, null, 2))
        return
      }
      console.log(list.length ? formatRunsAnalytics(list) : dim('no runs in the journal yet'))
      return
    }
    const record = loadRunRef(store, positional[0])
    if (flags.has('csv')) return writeCsv(analyticsRows([record]))
    const analytics = runAnalytics(record)
    if (flags.has('json')) {
      console.log(JSON.stringify(analytics, null, 2))
      return
    }
    console.log(`${bold(analytics.workflow)} ${dim(`· ${analytics.runId} · ${analytics.status}`)}\n`)
    console.log(formatAnalyticsTable(analytics))
    if (analytics.edges.length) console.log(`\nflow: ${analytics.edges.map((e) => `${e.from} → ${e.to}`).join(', ')}`)
    if (!analytics.steps.some((s) => s.in !== undefined || s.out !== undefined)) {
      console.log(dim('\nno step reported in/out counts. A step reports them with "metrics": {"in": …, "out": …} in its JSON output — see docs/analytics.ru.md.'))
    }
  } finally {
    store.close()
  }
}

/** `flora report [run-id] [--out file]` — the run as a markdown document. */
function commandReport(positional: string[], flags: Map<string, string[]>): void {
  const store = new RunStore()
  try {
    const record = loadRunRef(store, positional[0])
    const text = renderRunReport(record, { version: version() })
    const out = flags.get('out')?.[0]
    if (out) {
      writeFileSync(resolve(out), text)
      console.log(`${green('✓')} ${resolve(out)}`)
    } else {
      process.stdout.write(text)
    }
  } finally {
    store.close()
  }
}

/** `flora export [run-id] [--out file]` — one .flora-run file to hand over. */
function commandExport(positional: string[], flags: Map<string, string[]>): void {
  const store = new RunStore()
  try {
    const record = loadRunRef(store, positional[0])
    const result = exportRun(store, record.runId, { out: flags.get('out')?.[0], version: version() })
    console.log(`${green('✓')} ${bold(record.workflow)} ${dim(record.runId)} → ${result.out} ${dim(`(${formatBytes(result.bytes)}, ${result.events} events, ${result.artifacts} artifact file${result.artifacts === 1 ? '' : 's'})`)}`)
    console.log(`on the other side: ${bold(`flora open ${basename(result.out)}`)} — into their journal, the viewer up, the browser on it`)
  } finally {
    store.close()
  }
}

/** `flora import <file.flora-run> [--force]` — into this journal. */
function commandImport(positional: string[], flags: Map<string, string[]>): void {
  const file = positional[0]
  if (!file) throw new WorkflowError('flora import <run.flora-run> [--force]')
  const store = new RunStore()
  try {
    const result = importRun(store, file, { force: flags.has('force') })
    console.log(importedLine(result))
    console.log(`flora usage ${result.record.runId.slice(0, 8)} · flora report ${result.record.runId.slice(0, 8)} · flora open ${result.record.runId.slice(0, 8)}`)
  } finally {
    store.close()
  }
}

function importedLine(result: ReturnType<typeof importRun>): string {
  return `${green('✓')} ${bold(result.record.workflow)} ${dim(result.record.runId)} ${result.replaced ? 'replaced' : 'imported'} ${dim(`(${result.record.steps.length} steps, ${result.events} events, ${result.artifacts} artifact file${result.artifacts === 1 ? '' : 's'})`)}`
}

/** A run by id, id prefix, or the latest when nothing is given. */
function loadRunRef(store: RunStore, ref: string | undefined): RunRecord {
  const wanted = ref && ref !== 'latest' ? ref : store.list(1)[0]?.runId
  if (!wanted) throw new WorkflowError('no runs in the journal yet — flora run <workflow.yaml> first')
  const record = store.load(wanted) ?? store.list(200).map((r) => r.runId).filter((id) => id.startsWith(wanted)).map((id) => store.load(id))[0]
  if (!record) throw new WorkflowError(`no run "${wanted}" in the journal — flora runs lists them`)
  return record
}

/** Human-readable elapsed time; a run still going has no end yet. */
function formatDuration(run: RunSummary): string {
  if (!run.finishedAt) return '—'
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

function durationMs(run: RunSummary): number | null {
  if (!run.finishedAt) return null
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function commandRuns(flags: Map<string, string[]>): void {
  const store = new RunStore()
  store.sweepInterrupted()
  const runs = store.list()
  store.close()

  if (flags.has('json')) {
    // One JSON array, not newline-delimited: `flora runs --json | jq .` has to
    // parse as a single document, and a list of runs is small by construction.
    console.log(JSON.stringify(runs.map((run) => ({ ...run, durationMs: durationMs(run) })), null, 2))
    return
  }

  for (const run of runs) {
    console.log(
      `${run.startedAt}  ${run.status.padEnd(11)} ${formatDuration(run).padStart(7)}  ` +
        `${run.workflow}  ${dim(run.runId)}`
    )
  }
}

/**
 * `flora usage [run-id] [--json] [--all]` — tokens and money per step, every
 * attempt and branch counted; the latest run when no id is given, one line
 * per run with `--all`.
 */
function commandUsage(positional: string[], flags: Map<string, string[]>): void {
  const store = new RunStore()
  try {
    if (flags.has('all')) {
      const limit = Number(flags.get('limit')?.[0] ?? 50)
      const runs = store
        .list(Number.isFinite(limit) ? limit : 50)
        .map((summary) => store.load(summary.runId))
        .filter((record): record is NonNullable<typeof record> => record !== null)
        .map(runUsage)
      if (flags.has('json')) {
        console.log(JSON.stringify(runs, null, 2))
        return
      }
      for (const usage of runs) {
        const t = usage.total
        console.log(
          `${usage.status.padEnd(7)} ${usage.workflow.padEnd(24)} ` +
            `${(t.reported ? `${formatTokens(t.totalTokens)} tokens` : dim('no usage reported')).padStart(20)} ` +
            `${(t.costUsd !== undefined ? formatCost(t.costUsd) : '').padStart(9)}  ${dim(usage.runId)}`
        )
      }
      return
    }

    const record = loadRunRef(store, positional[0])
    const usage = runUsage(record)
    if (flags.has('json')) {
      console.log(JSON.stringify(usage, null, 2))
      return
    }
    console.log(`${bold(usage.workflow)} ${dim(`· ${usage.runId} · ${usage.status}`)}\n`)
    console.log(formatUsageTable(usage))
    if (!usage.total.reported) {
      console.log(
        dim(
          '\nno step reported usage. Claude Code, Codex and harmonia report it themselves; a command step\n' +
            'is counted when it prints a JSON line with a usage object ({"usage":{"input_tokens":…,"output_tokens":…,"calls":…,"cost_usd":…}})\n' +
            'or a summary line such as "tokens used: 12,345 · cost: $0.42".'
        )
      )
    }
  } finally {
    store.close()
  }
}

// ── bundles: pack / inspect / add / remove / workflows ─────────────────────

/** `flora pack <workflow.yaml> [--out file] [--exclude glob]... [--include glob]...` */
function commandPack(positional: string[], flags: Map<string, string[]>): void {
  const file = positional[0]
  if (!file) throw new WorkflowError('flora pack <workflow.yaml> [--out <name.flora>] [--exclude <glob>]... [--include <glob>]...')
  const result = packWorkflow(file, {
    out: flags.get('out')?.[0],
    exclude: flags.get('exclude'),
    include: flags.get('include'),
    floraVersion: version()
  })
  const m = result.manifest
  console.log(`${green('✓')} ${bold(m.name)} → ${result.out} ${dim(`(${formatBytes(result.bytes)}, ${m.files.length} files, ${m.steps.length} steps)`)}`)
  for (const f of m.files) console.log(dim(`  + ${f.path} (${formatBytes(f.bytes)})`))
  const notable = result.skipped.filter((s) => s.reason !== 'excluded' || !/^(\.git|node_modules|run|runs)(\/|$)/.test(s.path))
  for (const s of notable) console.log(dim(`  – ${s.path}: ${s.reason}`))
  console.log(`\nshare the file; on the other side: ${bold(`flora run ${basename(result.out)}`)} or ${bold(`flora add ${basename(result.out)}`)}`)
}

/** `flora inspect <bundle | name>` — what is inside before running it. */
function commandInspect(positional: string[]): void {
  const ref = positional[0]
  if (!ref) throw new WorkflowError('flora inspect <name.flora | installed name>')
  if (isBundlePath(ref)) {
    const bundle = readBundle(ref)
    console.log(describeBundle(bundle.manifest, ref))
    return
  }
  const installed = listInstalled().find((i) => i.name === ref)
  if (!installed) throw new WorkflowError(`no bundle file or installed workflow "${ref}"`)
  console.log(describeBundle(installed.manifest, installed.dir))
}

/** `flora add <bundle> [--force]` — into the library, runnable by name. */
function commandAdd(positional: string[], flags: Map<string, string[]>): void {
  const file = positional[0]
  if (!file) throw new WorkflowError('flora add <name.flora> [--force]')
  const installed = installBundle(file, { force: flags.has('force') })
  console.log(`${green('✓')} ${bold(installed.name)} installed → ${installed.dir}`)
  const required = Object.entries(installed.manifest.params).filter(([, d]) => d.required).map(([n]) => `--param ${n}=…`)
  console.log(`run it: ${bold(`flora run ${installed.name}${required.length ? ` ${required.join(' ')}` : ''}`)}${installed.manifest.harnesses.length ? dim(`  (needs: ${installed.manifest.harnesses.join(', ')} — flora doctor checks)`) : ''}`)
}

function commandRemove(positional: string[]): void {
  const name = positional[0]
  if (!name) throw new WorkflowError('flora remove <installed name>')
  if (!removeInstalled(name)) throw new WorkflowError(`"${name}" is not installed — flora workflows lists the library`)
  console.log(`${green('✓')} ${name} removed`)
}

function commandWorkflows(flags: Map<string, string[]>): void {
  const installed = listInstalled()
  if (flags.has('json')) {
    console.log(JSON.stringify(installed.map((i) => ({ name: i.name, dir: i.dir, workflow: i.workflow, manifest: i.manifest })), null, 2))
    return
  }
  if (!installed.length) {
    console.log(dim(`no installed workflows in ${libraryDir()} — flora add <name.flora> installs one`))
    return
  }
  for (const i of installed) {
    const m = i.manifest
    console.log(`${bold(i.name.padEnd(24))} ${String(m.version !== undefined ? `v${String(m.version)}` : '').padEnd(6)} ${String(m.steps.length).padStart(2)} steps  ${m.harnesses.join(', ').padEnd(24)} ${dim(i.dir)}`)
    if (m.description) console.log(`  ${dim(m.description)}`)
  }
}

/** The viewer on the port from --port, closing cleanly on ctrl-c. */
async function startViewer(flags: Map<string, string[]>): Promise<RunningServer> {
  const port = Number(flags.get('port')?.[0] ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new WorkflowError(`--port expects a port number, got "${flags.get('port')?.[0]}"`)
  }
  const running = await startServer({ port })
  onStopSignal(() => {
    void running.close().then(() => process.exit(0))
  })
  return running
}

async function commandServe(flags: Map<string, string[]>): Promise<void> {
  const running = await startViewer(flags)
  console.log(`${bold('flora viewer')} ${dim('·')} ${running.url}
${dim('reading ~/.flora/flora.db · ctrl-c to stop')}`)
}

/**
 * `flora open [<file.flora-run> | <run-id>] [--port 4180] [--force] [--no-browser]`: the one
 * command for a run someone handed over as a file — into the journal (kept as
 * it is when already there; --force replaces it), the viewer up, the browser
 * on that run. A run id opens one from the journal; nothing opens the list.
 */
async function commandOpen(positional: string[], flags: Map<string, string[]>): Promise<void> {
  const ref = positional[0]
  let runId: string | undefined
  const store = new RunStore()
  try {
    if (ref && isRunFilePath(ref)) {
      const known = store.load(readRunFile(ref).record.runId)
      if (known && !flags.has('force')) {
        runId = known.runId
        console.log(dim(`${basename(ref)} is already in the journal as ${known.runId.slice(0, 8)} — flora open ${basename(ref)} --force replaces it`))
      } else {
        const result = importRun(store, ref, { force: flags.has('force') })
        runId = result.record.runId
        console.log(importedLine(result))
      }
    } else if (ref) {
      runId = loadRunRef(store, ref).runId
    }
  } finally {
    store.close()
  }
  const running = await startViewer(flags)
  const url = runId ? `${running.url}/runs/${encodeURIComponent(runId)}` : running.url
  console.log(`${bold('flora viewer')} ${dim('·')} ${url}
${dim('reading ~/.flora/flora.db · ctrl-c to stop')}`)
  // --no-browser: a headless box, or a test — the address is on screen either way.
  if (!flags.has('no-browser')) openInBrowser(url, (reason) => console.log(dim(`no browser opened (${reason}) — use the address above`)))
}

/** `flora gate install <workflow> | status | uninstall` — the pre-push hook. */
function commandGate(positional: string[], flags: Map<string, string[]>): void {
  const repo = resolve(flags.get('cwd')?.[0] ?? process.cwd())
  const sub = positional[0]
  if (sub === 'install') {
    const workflow = positional[1]
    if (!workflow) throw new WorkflowError('flora gate install <workflow.yaml>')
    const status = gateInstall(repo, workflow)
    console.log(`${green('✓')} pre-push gate installed: ${status.hookPath}\n  runs ${status.workflow} before every push from ${repo}`)
    return
  }
  if (sub === 'uninstall') {
    console.log(gateUninstall(repo) ? `${green('✓')} pre-push gate removed` : dim('no pre-push gate was installed'))
    return
  }
  if (sub === 'status' || sub === undefined) {
    const status = gateStatus(repo)
    if (!status.installed) console.log(dim(`no pre-push hook at ${status.hookPath}`))
    else if (!status.ours) console.log(`pre-push hook at ${status.hookPath} is not flora's`)
    else if (status.stale) console.log(`${red('✗')} gate installed but stale: ${status.stale}`)
    else console.log(`${green('✓')} gate installed: ${status.workflow}\n  hook ${status.hookPath}`)
    return
  }
  throw new WorkflowError(`flora gate: unknown subcommand "${sub}" (install | status | uninstall)`)
}

/** `flora doctor`: is this machine ready? Exit 1 when a required piece is broken. */
async function commandDoctor(): Promise<void> {
  const probes = await doctor()
  console.log(formatProbes(probes))
  const broken = probes.filter((p) => p.ok === false)
  if (broken.length) {
    console.log(red(`\n${broken.length} problem(s) — a step on a harness marked ✗ will fail with the same message`))
    process.exit(1)
  }
  console.log(green('\nready'))
}

/**
 * `flora watch [paths…]`: arm every workflow with an `on:` block and stay up.
 * `--once` runs a single polling pass (cron does not fire) and exits — for
 * debugging a source, or for a cron job that prefers to own the schedule.
 */
async function commandWatch(positional: string[], flags: Map<string, string[]>): Promise<void> {
  const cwd = resolve(flags.get('cwd')?.[0] ?? process.cwd())
  const paths = (positional.length ? positional : ['workflows']).map((p) => resolve(p))
  const watcher = new Watcher({ paths, cwd, params: parseParams(flags), log: (line) => console.error(line) })
  if (!watcher.workflows.length) {
    throw new WorkflowError(`no workflow with an "on:" block under ${paths.join(', ')}`)
  }

  if (flags.has('once')) {
    const started = await watcher.once()
    await watcher.stop()
    console.error(`[flora watch] --once: ${started} run(s) started`)
    return
  }

  watcher.start()
  console.error(`${bold('flora watch')} ${dim('·')} ${watcher.workflows.length} workflow(s) armed · ctrl-c to stop`)
  onStopSignal(() => {
    console.error(dim('[flora watch] stopping — waiting for runs in flight'))
    void watcher.stop().then(() => process.exit(0))
  }, { graceMs: 0 })
}

/**
 * `flora mcp` started by a step (see src/tools.ts) carries the step's context
 * and nesting bookkeeping on the command line; a bare `flora mcp` has none.
 */
function mcpOptions(flags: Map<string, string[]>): McpServerOptions {
  const one = (name: string): string | undefined => flags.get(name)?.[0]
  const depth = one('depth')
  return {
    context: one('context'),
    cwd: one('cwd'),
    runId: one('run'),
    depth: depth !== undefined ? Number(depth) : undefined,
    stack: one('stack')?.split(delimiter).filter(Boolean),
    allowWorkflows: flags.get('allow-workflow')
  }
}

function printUsage(): void {
  console.log(`flora — local-first workflow contracts for AI coding harnesses

Usage:
  flora doctor                   is this machine ready? harnesses, logins, journal
  flora connect --client <codex|claude-code|claude-desktop|generic> [--cwd <dir>] [--out <new-file>]
                                 print the MCP settings an agent needs to author and run workflows
  flora --version
  flora run <workflow.yaml | name.flora | installed name> [--param name=value]... [--cwd <dir>] [--report <file|dir>]
  flora pack <workflow.yaml> [--out name.flora] [--exclude glob]... [--include glob]...
                                 one shareable file: the workflow and the folder it lives in
  flora inspect <name.flora | name>   what a bundle contains before you run it
  flora add <name.flora> [--force]    install into ~/.flora/workflows, then flora run <name>
  flora workflows [--json]       the installed library;  flora remove <name>
  flora runs [--json]            list recent runs
  flora usage [run-id] [--json]  tokens and cost per step of a run (latest by default); --all: per run
  flora analytics [run-id] [--json] [--csv [file]]   what went in, what came out, what it cost — per step
  flora analytics --all [--workflow name] [--limit n] [--csv file]   the same across runs; --csv for a spreadsheet
  flora report [run-id] [--out file]   the run as a markdown document (also written after every run)
  flora export [run-id] [--out file]   one .flora-run file with the record, events and report
  flora import <file.flora-run> [--force]   a run from someone else into this journal
  flora serve [--port 4180]      browse runs at http://127.0.0.1:4180
  flora open [<file.flora-run> | <run-id>] [--port 4180] [--force] [--no-browser]
                                 a run someone sent you: into the journal, the viewer up, your browser on it
  flora mcp                      MCP server over stdio for agents authoring workflows
  flora watch [paths…] [--once] [--param name=value]...
                                 fire workflows with an on: block (cron / sentry / command)
  flora gate install <workflow.yaml> | status | uninstall   [--cwd <repo>]
                                 run a workflow before every git push; a failed run blocks it

A workflow is a YAML contract: steps, each with an executor
(claude-code | codex | antigravity | harmonia | command | api) and verification checks.
The verifier runs checks itself — a step passes only when they do.`)
}

/** Commands that own work in flight: losing the terminal must not end them. */
const LONG_RUNNING = new Set(['run', 'watch', 'serve', 'open'])
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
/** How long a stop may take before flora leaves anyway (a stuck cleanup must not make it unkillable). */
const STOP_GRACE_MS = 10_000

// WHY: docs/decisions/2026-11-16-stop-signals-and-closed-output.md
/**
 * One stop path for every way a supervisor ends a process. Only ctrl-c used to
 * be handled: `kill`, launchd, a closed terminal (SIGTERM, SIGHUP) took flora
 * down at once, while the step it had started lived on in its own process group
 * and the journal kept saying `running`.
 *
 * The first signal starts the orderly stop. A second one, or `graceMs` without
 * the process ending, exits with the conventional 128 + signal number — pass
 * `graceMs: 0` where waiting is the point (`watch` lets runs in flight finish).
 */
function onStopSignal(stop: () => void, { graceMs = STOP_GRACE_MS }: { graceMs?: number } = {}): void {
  let stopping = false
  for (const name of STOP_SIGNALS) {
    process.on(name, () => {
      const code = 128 + (osConstants.signals[name] ?? 0)
      if (stopping) process.exit(code)
      stopping = true
      if (graceMs > 0) setTimeout(() => process.exit(code), graceMs).unref()
      stop()
    })
  }
}

/**
 * `flora runs --json | head` closes our stdout early; without this the process
 * dies on an unhandled EPIPE and prints a stack trace over the user's pipeline.
 * For a listing, exiting quietly is right: nobody is reading.
 *
 * A long-running command is different — the reader going away (a supervisor
 * restarted, a terminal closed) says nothing about the work. Exiting 0 there
 * reported success for a run that had not finished and abandoned its step, so
 * these commands go on without output; stderr gets the same treatment because
 * nothing handled its EPIPE at all.
 */
function tolerateClosedOutput(command: string | undefined): void {
  const keepRunning = command !== undefined && LONG_RUNNING.has(command)
  const handle = (err: NodeJS.ErrnoException): void => {
    if (err.code !== 'EPIPE') throw err
    if (!keepRunning) process.exit(0)
  }
  process.stdout.on('error', handle)
  if (keepRunning) process.stderr.on('error', handle)
}

async function main(): Promise<void> {
  tolerateClosedOutput(process.argv[2])
  if (process.argv.includes('--version') || process.argv[2] === 'version') {
    console.log(version())
    return
  }
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  if (command === 'run') return commandRun(positional, flags)
  if (command === 'connect') {
    const text = connectionConfig(flags.get('client')?.[0] ?? 'generic', resolve(flags.get('cwd')?.[0] ?? process.cwd()))
    const out = flags.get('out')?.[0]
    if (out) writeFileSync(resolve(out), text, { flag: 'wx' })
    else process.stdout.write(text)
    return
  }
  if (command === 'runs') return commandRuns(flags)
  if (command === 'usage') return commandUsage(positional, flags)
  if (command === 'analytics') return commandAnalytics(positional, flags)
  if (command === 'report') return commandReport(positional, flags)
  if (command === 'export') return commandExport(positional, flags)
  if (command === 'import') return commandImport(positional, flags)
  if (command === 'pack') return commandPack(positional, flags)
  if (command === 'inspect') return commandInspect(positional)
  if (command === 'add') return commandAdd(positional, flags)
  if (command === 'remove') return commandRemove(positional)
  if (command === 'workflows') return commandWorkflows(flags)
  if (command === 'serve') return commandServe(flags)
  if (command === 'open') return commandOpen(positional, flags)
  // stdout is the protocol channel here: nothing else may print to it.
  if (command === 'mcp') return serveMcp(mcpOptions(flags))
  if (command === 'watch') return commandWatch(positional, flags)
  if (command === 'doctor') return commandDoctor()
  if (command === 'gate') return commandGate(positional, flags)
  printUsage()
  process.exit(command ? 1 : 0)
}

main().catch((err) => {
  if (err instanceof WorkflowError) console.error(red(err.message))
  else console.error(red(`fatal: ${err?.message ?? err}`))
  process.exit(1)
})
