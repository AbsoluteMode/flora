import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { floraHome } from '../paths'
import { renderRunReport } from '../report'
import { effectiveStatus, RunStore } from '../state'
import { containedPath } from '../safe-path'

/** The viewer is local-only by construction: there is no flag to bind elsewhere. */
export const HOST = '127.0.0.1'
export const DEFAULT_PORT = 4180

const DEFAULT_WEB_ROOT = resolve(fileURLToPath(import.meta.url), '../../../web')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

export interface ServeOptions {
  port?: number
  /** Journal to read from; defaults to the same database the CLI writes. */
  dbPath?: string
  webRoot?: string
}

export interface RunningServer {
  server: Server
  port: number
  url: string
  close(): Promise<void>
}

/**
 * Read-only HTTP viewer over the run journal. It only ever reads: no route
 * mutates a run, and the engine is not imported here at all.
 */
export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const store = new RunStore(options.dbPath)
  const webRoot = resolve(options.webRoot ?? DEFAULT_WEB_ROOT)
  // Run artifacts live next to the journal they belong to.
  const home = options.dbPath ? dirname(resolve(options.dbPath)) : floraHome()
  const server = createServer(handler(store, webRoot, home))

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(options.port ?? DEFAULT_PORT, HOST, () => {
      server.removeListener('error', fail)
      ok()
    })
  }).catch((error) => { store.close(); throw error })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? DEFAULT_PORT)
  return {
    server,
    port,
    url: `http://${HOST}:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => {
          store.close()
          ok()
        })
        // Browsers hold the connection open (and #3 will hold an SSE stream on
        // it); without this, close() waits on them and ctrl-c feels hung.
        server.closeAllConnections()
      })
  }
}

function handler(store: RunStore, webRoot: string, home: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isLocalHost(req)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden host')
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // The viewer is read-only; say so rather than 404-ing.
        res.setHeader('Allow', 'GET, HEAD')
        return sendJson(res, 405, { error: 'the viewer is read-only' })
      }

      const url = new URL(req.url ?? '/', `http://${HOST}`)
      const path = decodeURIComponent(url.pathname)

      if (path === '/api/runs') {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return sendJson(res, 400, { error: 'limit must be an integer from 1 to 1000' })
        // Read-only, so a dead run is shown as interrupted rather than written as such.
        return sendJson(
          res,
          200,
          store.list(limit).map((run) => {
            const status = effectiveStatus(run)
            return status === run.status ? run : { ...run, status, finishedAt: run.heartbeatAt ?? run.startedAt }
          })
        )
      }
      const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(path)
      if (eventsMatch) return streamEvents(store, req, res, eventsMatch[1], url)

      // A step's declared artifact — a prompt it sent, an answer it got, a log.
      const artifactMatch = /^\/api\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(path)
      if (artifactMatch) {
        const record = store.load(artifactMatch[1])
        if (!record) return sendJson(res, 404, { error: 'no such run' })
        const known = record.steps.flatMap((s) => [...(s.artifacts ?? []), ...(s.branches ?? []).flatMap((b) => b.artifacts ?? [])]).some((a) => a.path === artifactMatch[2])
        if (!known) return sendJson(res, 404, { error: 'no such artifact' })
        let root: string
        try { root = containedPath(home, `runs/${record.runId}/artifacts`) }
        catch { return sendJson(res, 404, { error: 'no such artifact' }) }
        if (await serveFile(res, root, `/${artifactMatch[2]}`, true)) return
        return sendJson(res, 404, { error: 'artifact file is missing on this machine' })
      }
      // The run as a document — what "Report" on the run page downloads.
      const reportMatch = /^\/api\/runs\/([^/]+)\/report\.md$/.exec(path)
      if (reportMatch) {
        const record = store.load(reportMatch[1])
        if (!record) return sendJson(res, 404, { error: 'no such run' })
        res.setHeader('content-disposition', `attachment; filename="${record.workflow.replace(/[^A-Za-z0-9._-]+/g, '-')}-${record.runId.slice(0, 8)}.md"`)
        return send(res, 200, 'text/markdown; charset=utf-8', renderRunReport(record))
      }
      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path)
      if (runMatch) {
        const record = store.load(runMatch[1])
        if (!record) return sendJson(res, 404, { error: 'no such run' })
        if (record.status === 'running') {
          const summary = store.summary(record.runId)
          if (summary && effectiveStatus(summary) === 'interrupted') {
            record.status = 'interrupted'
            record.finishedAt = summary.heartbeatAt ?? summary.startedAt
          }
        }
        return sendJson(res, 200, record)
      }
      if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'no such endpoint' })

      // Static assets, with /runs/<id> falling back to the app shell.
      const asset = path === '/' ? '/index.html' : path
      if (await serveFile(res, webRoot, asset)) return
      if (!extname(asset)) {
        if (await serveFile(res, webRoot, '/index.html')) return
      }
      send(res, 404, 'text/plain; charset=utf-8', 'not found')
    } catch (err) {
      if (res.headersSent || res.destroyed) { res.destroy(); return }
      sendJson(res, 500, { error: (err as Error).message })
    }
  }
}

/** How often the stream looks for new rows — SQLite has no notify to listen to. */
const POLL_MS = 300
const HEARTBEAT_MS = 15_000

/**
 * Server-sent events for one run. `seq` from the journal is the event id, so a
 * browser reconnect (which replays Last-Event-ID for us) resumes exactly where
 * it stopped.
 */
function streamEvents(
  store: RunStore,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  url: URL
): void {
  const record = store.load(runId)
  if (!record) return sendJson(res, 404, { error: 'no such run' })

  const resumeFrom = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0'
  let cursor = Number(Array.isArray(resumeFrom) ? resumeFrom[0] : resumeFrom)
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Belt and braces if anyone ever puts a proxy in front of the viewer.
    'x-accel-buffering': 'no'
  })
  if (req.method === 'HEAD') { res.end(); return }

  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    clearInterval(poll)
    clearInterval(beat)
    res.end()
  }

  const drain = (): void => {
    if (done) return
    let events
    try {
      events = store.readEvents(runId, cursor)
    } catch {
      finish()
      return
    }
    for (const event of events) {
      cursor = event.seq
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`)
      if (event.type === 'run_end') return finish()
    }
    // A run that was already over before anyone subscribed has nothing more
    // coming; close instead of leaving EventSource to reconnect forever.
    if (!events.length) {
      const summary = store.summary(runId)
      if (!summary || effectiveStatus(summary) !== 'running') finish()
    }
  }

  const poll = setInterval(drain, POLL_MS)
  const beat = setInterval(() => {
    if (!done) res.write(': ping\n\n')
  }, HEARTBEAT_MS)

  req.on('close', finish)
  drain()
}

/**
 * Cheap defence against DNS rebinding: a page on evil.com can resolve its own
 * name to 127.0.0.1, but the Host header it sends is still evil.com.
 */
function isLocalHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return true
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === HOST || name === 'localhost' || name === '::1'
}

async function serveFile(res: ServerResponse, root: string, requested: string, asText = false): Promise<boolean> {
  try {
    const target = containedPath(root, requested.replace(/^\//, ''))
    const info = await stat(target)
    if (!info.isFile()) return false
    // Artifacts are shown as text (prompts, answers, logs), never executed as pages.
    const type = asText ? 'text/plain; charset=utf-8' : (MIME[extname(target)] ?? 'application/octet-stream')
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      // Hashless filenames, so only the immutable font blobs may be cached.
      'cache-control': extname(target) === '.woff2' ? 'public, max-age=604800' : 'no-cache'
    })
    if (res.req.method === 'HEAD') {
      res.end()
      return true
    }
    // pipeline also closes the source when a browser disconnects mid-download.
    await pipeline(createReadStream(target), res)
    return true
  } catch {
    if (res.headersSent || res.destroyed) { res.destroy(); return true }
    return false
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body))
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
  res.end(res.req.method === 'HEAD' ? undefined : body)
}
