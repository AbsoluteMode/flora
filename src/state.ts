import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RunRecord, RunSummary } from './types'
import { floraHome } from './paths'

/** One row of the live event log; `seq` doubles as the SSE cursor. */
export interface StoredEvent {
  seq: number
  at: string
  type: string
  payload: Record<string, unknown>
}

export interface EventToAppend {
  at: string
  type: string
  payload: Record<string, unknown>
}

/** A running run whose last heartbeat is older than this is treated as interrupted. */
export const STALE_RUN_MS = 90_000
/** How often a recording process signs in. */
export const HEARTBEAT_MS = 15_000

/**
 * What a run's status is right now, without writing: a read-only reader (the
 * viewer) shows a dead run as interrupted even before a CLI sweep records it.
 */
export function effectiveStatus(run: Pick<RunSummary, 'status' | 'startedAt' | 'heartbeatAt'>, now = Date.now()): RunRecord['status'] {
  if (run.status !== 'running') return run.status
  return now - Date.parse(run.heartbeatAt ?? run.startedAt) < STALE_RUN_MS ? 'running' : 'interrupted'
}

/** `FLORA_DB` overrides the journal location — handy for tests and throwaway runs. */
export function defaultDbPath(): string {
  return process.env.FLORA_DB ?? join(floraHome(), 'flora.db')
}

/** Persistent run journal — the local source of truth a viewer/hub reads from. */
export class RunStore {
  private db: DatabaseSync

  constructor(path = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        record TEXT NOT NULL
      );

      -- Live event log. AUTOINCREMENT matters: trimming output (see
      -- trimOutputEvents) frees rowids, and without it SQLite would hand the
      -- same seq out twice — an SSE client resuming from Last-Event-ID would
      -- then silently skip or repeat frames.
      CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS run_events_by_run ON run_events (run_id, seq);

      -- What flora watch has already reacted to. The key includes the
      -- workflow: one event may legitimately start several of them.
      CREATE TABLE IF NOT EXISTS seen_events (
        source TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        workflow TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        run_id TEXT,
        PRIMARY KEY (source, fingerprint, workflow)
      );
    `)
    // Journals from before heartbeats: add the column in place.
    const columns = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'heartbeat_at')) this.db.exec('ALTER TABLE runs ADD COLUMN heartbeat_at TEXT')
  }

  /** The recording process is alive; called on every save and on a timer in between. */
  heartbeat(runId: string): void {
    this.db.prepare('UPDATE runs SET heartbeat_at = ? WHERE run_id = ?').run(new Date().toISOString(), runId)
  }

  /**
   * Runs still marked running whose process stopped reporting: the flora
   * that ran them was killed, crashed, or the machine went down, so no
   * run_end ever came. They become `interrupted` — in the index and in the
   * record, with any step still "running" failed for the same reason —
   * instead of looking alive forever. Returns how many were marked.
   */
  sweepInterrupted(now = Date.now(), staleMs = STALE_RUN_MS): number {
    const rows = this.db.prepare("SELECT run_id, started_at, heartbeat_at FROM runs WHERE status = 'running'").all() as Array<{
      run_id: string
      started_at: string
      heartbeat_at: string | null
    }>
    let marked = 0
    for (const row of rows) {
      const lastSeen = row.heartbeat_at ?? row.started_at
      if (now - Date.parse(lastSeen) < staleMs) continue
      const record = this.load(row.run_id)
      if (!record) continue
      record.status = 'interrupted'
      record.finishedAt = lastSeen
      for (const step of record.steps) {
        if (step.status === 'running' || step.status === 'verifying') {
          step.status = 'failed'
          step.error = 'interrupted: the flora process ended before the step finished'
        }
      }
      this.save(record)
      marked++
    }
    return marked
  }

  /** Claim an event for a workflow; false when it had been claimed before. Atomic: one INSERT. */
  markSeen(source: string, fingerprint: string, workflow: string): boolean {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO seen_events (source, fingerprint, workflow, first_seen) VALUES (?, ?, ?, ?)'
      )
      .run(source, fingerprint, workflow, new Date().toISOString())
    return Number(result.changes) === 1
  }

  attachRun(source: string, fingerprint: string, workflow: string, runId: string): void {
    this.db
      .prepare('UPDATE seen_events SET run_id = ? WHERE source = ? AND fingerprint = ? AND workflow = ?')
      .run(runId, source, fingerprint, workflow)
  }

  /** Forget fingerprints older than `maxAgeDays`; returns how many were dropped. */
  pruneSeen(maxAgeDays: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString()
    // `<=`: a claim made in the same millisecond as the cutoff is as old as asked for.
    const result = this.db.prepare('DELETE FROM seen_events WHERE first_seen <= ?').run(cutoff)
    return Number(result.changes)
  }

  save(record: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, workflow, status, started_at, finished_at, record, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           workflow = excluded.workflow, status = excluded.status, finished_at = excluded.finished_at,
           record = excluded.record, heartbeat_at = excluded.heartbeat_at`
      )
      .run(
        record.runId,
        record.workflow,
        record.status,
        record.startedAt,
        record.finishedAt ?? null,
        JSON.stringify(record),
        new Date().toISOString()
      )
  }

  load(runId: string): RunRecord | null {
    const row = this.db.prepare('SELECT record FROM runs WHERE run_id = ?').get(runId) as
      | { record: string }
      | undefined
    return row ? (JSON.parse(row.record) as RunRecord) : null
  }

  /** Exact heartbeat lookup, independent of the latest-run page size. */
  summary(runId: string): RunSummary | null {
    const row = this.db.prepare(`SELECT run_id AS runId, workflow, status, started_at AS startedAt,
      finished_at AS finishedAt, heartbeat_at AS heartbeatAt FROM runs WHERE run_id = ?`).get(runId) as
      | (Omit<RunSummary, 'finishedAt' | 'heartbeatAt'> & { finishedAt: string | null; heartbeatAt: string | null })
      | undefined
    return row ? { ...row, finishedAt: row.finishedAt ?? undefined, heartbeatAt: row.heartbeatAt ?? undefined } : null
  }

  list(limit = 20): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT run_id, workflow, status, started_at, finished_at, heartbeat_at
         FROM runs ORDER BY started_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      run_id: string
      workflow: string
      status: string
      started_at: string
      finished_at: string | null
      heartbeat_at: string | null
    }>
    return rows.map((r) => ({
      runId: r.run_id,
      workflow: r.workflow,
      status: r.status as RunRecord['status'],
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      heartbeatAt: r.heartbeat_at ?? undefined
    }))
  }

  appendEvents(runId: string, events: EventToAppend[]): void {
    if (!events.length) return
    const insert = this.db.prepare(
      'INSERT INTO run_events (run_id, at, type, payload) VALUES (?, ?, ?, ?)'
    )
    this.db.exec('BEGIN')
    try {
      for (const event of events) {
        insert.run(runId, event.at, event.type, JSON.stringify(event.payload))
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  readEvents(runId: string, afterSeq = 0, limit = 500): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, at, type, payload FROM run_events
         WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`
      )
      .all(runId, afterSeq, limit) as Array<{
      seq: number
      at: string
      type: string
      payload: string
    }>
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>
    }))
  }

  /**
   * Keep only the tail of a run's executor output. A chatty harness can emit
   * megabytes, and this table is a live feed, not an archive — the complete
   * output is saved with the step's evidence in `runs`. Structural events are
   * never trimmed: they are the run's state machine.
   */
  trimOutputEvents(runId: string, maxBytes: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM run_events WHERE seq IN (
           SELECT seq FROM (
             SELECT seq, SUM(LENGTH(payload)) OVER (ORDER BY seq DESC) AS kept
             FROM run_events WHERE run_id = ? AND type = 'executor_output'
           ) WHERE kept > ?
         )`
      )
      .run(runId, maxBytes)
    return Number(result.changes)
  }

  close(): void {
    this.db.close()
  }
}
