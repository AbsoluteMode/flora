// flora run viewer — plain ES modules, no build step. See PR notes for why.
//
// Everything rendered here comes out of a run journal that an AI harness wrote
// into, so nothing is ever interpolated as HTML: `el()` sets text through
// textContent and attributes through setAttribute.

import { renderMarkdown } from './markdown.js'
import { openStepInspector } from './step-inspector.js'

const view = document.getElementById('view')

/** Tiny DOM builder. Strings become text nodes, never markup. */
function el(tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'text') node.textContent = String(value)
    else if (key === 'class') node.className = value
    else node.setAttribute(key, String(value))
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

// ── formatting ──────────────────────────────────────────────────────────────

const MARK = { passed: '✓', failed: '✗', error: '!', interrupted: '!', running: '·', skipped: '–' }

function durationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null
  const ms = Date.parse(finishedAt) - Date.parse(startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

function formatWhen(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso ?? '—'
  return at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** "1.2k → 340 (8k cached)" — or nothing, when the harness reported nothing. */
function describeUsage(usage) {
  if (!usage) return null
  // A harness that failed before doing anything reports zeros; "0 → 0" says nothing.
  if (Object.values(usage).every((n) => !n)) return null
  const k = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return usage.totalTokens !== undefined ? k(usage.totalTokens) : null
  }
  let text = `${k(usage.inputTokens ?? 0)} → ${k(usage.outputTokens ?? 0)}`
  if (usage.cachedTokens) text += ` (${k(usage.cachedTokens)} cached)`
  return text
}

// ── usage: what the run spent, per step ─────────────────────────────────────
// Mirrors src/usage.ts: every attempt and every branch counts; a step that
// reported nothing shows dashes, not zeros.

const USAGE_KEYS = ['calls', 'inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens']

function addUsage(line, evidence) {
  if (!evidence) return
  const usage = evidence.usage
  if (usage) {
    for (const key of USAGE_KEYS) if (usage[key] !== undefined) line[key] = (line[key] ?? 0) + usage[key]
    if (usage.totalTokens === undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
      line.totalTokens = (line.totalTokens ?? 0) + (usage.contextTokens ?? usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    }
  }
  const cost = evidence.costUsd ?? usage?.costUsd
  if (cost !== undefined) line.costUsd = (line.costUsd ?? 0) + cost
  if (usage || cost !== undefined) line.reported = true
}

function usageOfStep(step) {
  const line = { stepId: step.stepId, status: step.status, attempts: step.status === 'skipped' ? 0 : 1 + (step.priorAttempts?.length ?? 0), reported: false }
  const attempts = step.branches?.length ? step.branches.map((b) => b.evidence) : [step.evidence]
  for (const evidence of attempts) addUsage(line, evidence)
  for (const earlier of step.priorAttempts ?? []) addUsage(line, earlier.evidence)
  return line
}

const formatTokens = (n) => (n === undefined ? '–' : n.toLocaleString('en-US'))
const formatCost = (n) => (n === undefined ? '–' : `$${n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4)}`)

function usageTable(run) {
  const lines = (run.steps ?? []).filter((s) => s.status !== 'skipped').map(usageOfStep)
  if (!lines.some((l) => l.reported)) return null
  const total = { stepId: 'total', attempts: 0, reported: true }
  for (const l of lines) {
    total.attempts += l.attempts
    for (const key of [...USAGE_KEYS, 'costUsd']) if (l[key] !== undefined) total[key] = (total[key] ?? 0) + l[key]
  }
  const columns = [
    ['attempts', 'attempts', (l) => (l.attempts ? String(l.attempts) : '–')],
    ['calls', 'calls', (l) => formatTokens(l.calls)],
    ['inputTokens', 'input', (l) => formatTokens(l.inputTokens)],
    ['outputTokens', 'output', (l) => formatTokens(l.outputTokens)],
    ['totalTokens', 'total', (l) => formatTokens(l.totalTokens)],
    ['costUsd', 'cost', (l) => formatCost(l.costUsd)]
  ]
  const row = (l, cls) =>
    el('tr', cls ? { class: cls } : {}, el('th', { scope: 'row', text: l.stepId }), ...columns.map(([, , render]) => el('td', { text: render(l) })))
  return el(
    'section',
    { class: 'usage' },
    el('h2', { text: 'Usage' }),
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', { text: 'step' }), ...columns.map(([, head]) => el('th', { text: head })))),
      el('tbody', {}, ...lines.map((l) => row(l))),
      el('tfoot', {}, row(total, 'total'))
    )
  )
}

// ── analytics: what went in, what came out, what it cost ────────────────────
// Mirrors src/analytics.ts. The flow is drawn as a small layered graph:
// a step sits one column to the right of the steps it draws on.

const formatBytes = (n) => (n === undefined ? '–' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const flowText = (s) => (s.in === undefined && s.out === undefined ? '–' : `${formatTokens(s.in)} → ${formatTokens(s.out)}`)

function stepAnalytics(step) {
  const usage = usageOfStep(step)
  const metrics = step.metrics ?? {}
  return {
    stepId: step.stepId,
    status: step.status,
    inputsFrom: step.inputsFrom ?? [],
    in: typeof metrics.in === 'number' ? metrics.in : undefined,
    out: typeof metrics.out === 'number' ? metrics.out : undefined,
    metrics,
    durationMs: step.evidence?.durationMs ?? (step.branches?.length ? Math.max(...step.branches.map((b) => b.evidence?.durationMs ?? 0)) : undefined),
    calls: usage.calls,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    outputBytes: step.outputBytes
  }
}

function analyticsBlock(run) {
  const steps = (run.steps ?? []).map(stepAnalytics)
  const known = new Set(steps.map((s) => s.stepId))
  const edges = steps.flatMap((s) => s.inputsFrom.filter((f) => known.has(f)).map((f) => ({ from: f, to: s.stepId })))
  const informative = steps.some((s) => s.in !== undefined || s.out !== undefined || s.outputBytes !== undefined || Object.keys(s.metrics).length)
  if (!edges.length && !informative) return null

  const shown = steps.filter((s) => s.status !== 'skipped')
  const columns = [
    ['from', (s) => s.inputsFrom.join(', ') || '–', 'left'],
    ['in → out', flowText],
    ['took', (s) => formatMs(s.durationMs)],
    ['calls', (s) => formatTokens(s.calls)],
    ['tokens', (s) => formatTokens(s.totalTokens)],
    ['cost', (s) => formatCost(s.costUsd)],
    ['output', (s) => formatBytes(s.outputBytes)]
  ]
  const row = (s) =>
    el('tr', {}, el('th', { scope: 'row', text: s.stepId }), ...columns.map(([, render, align]) => el('td', align ? { class: 'left', text: render(s) } : { text: render(s) })))
  const extras = shown.filter((s) => Object.keys(s.metrics).some((k) => k !== 'in' && k !== 'out'))
  return el(
    'section',
    { class: 'usage analytics' },
    el('h2', { text: 'Analytics' }),
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', { text: 'step' }), ...columns.map(([head, , align]) => el('th', align ? { class: 'left', text: head } : { text: head })))),
      el('tbody', {}, ...shown.map(row))
    ),
    extras.length
      ? el(
          'ul',
          { class: 'metrics' },
          ...extras.map((s) =>
            el('li', {}, el('b', { text: s.stepId }), ' ', Object.entries(s.metrics).map(([k, v]) => `${k} = ${formatTokens(v)}`).join(' · '))
          )
        )
      : null
  )
}

// ── pipeline canvas: the run as a node graph you can move around and open ──
// Nodes are steps, edges are `inputsFrom` (needs + {{steps.<id>…}}). Drag a
// node to rearrange (kept per workflow in localStorage), drag the background
// to pan, scroll to zoom, click a step to open it in the drawer. Layout:
// column = longest path from a source, like a build graph.

const NODE_W = 196
const NODE_H = 66
const GAP_X = 72
const GAP_Y = 22
let currentCanvas = null

function layoutKey(run) {
  return `flora.layout.${run.workflow}`
}

function savedLayout(run) {
  try {
    const value = JSON.parse(localStorage.getItem(layoutKey(run)) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.create(null)
    return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).filter(([, point]) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 1e6 && Math.abs(point.y) <= 1e6
    )))
  } catch {
    return Object.create(null)
  }
}

function autoLayout(steps) {
  const ids = new Set(steps.map((s) => s.stepId))
  const inputs = new Map(steps.map((s) => [s.stepId, (s.inputsFrom ?? []).filter((f) => ids.has(f))]))
  const depth = new Map()
  const visit = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id)
    if (seen.has(id)) return 0
    seen.add(id)
    const d = Math.max(-1, ...(inputs.get(id) ?? []).map((f) => visit(f, seen))) + 1
    depth.set(id, d)
    return d
  }
  for (const s of steps) visit(s.stepId)
  const columns = []
  for (const s of steps) (columns[depth.get(s.stepId)] ??= []).push(s)
  // A long chain wraps like text: PER_ROW columns per band, odd bands run
  // right to left so the edge into the next band stays short.
  const PER_ROW = 4
  const bands = []
  columns.forEach((col, ci) => (bands[Math.floor(ci / PER_ROW)] ??= []).push({ col, ci }))
  const pos = new Map()
  let y0 = 0
  bands.forEach((band, bi) => {
    const rows = Math.max(1, ...band.map(({ col }) => col.length))
    const bandH = rows * NODE_H + (rows - 1) * GAP_Y
    for (const { col, ci } of band) {
      const slot = ci % PER_ROW
      const x = (bi % 2 === 0 ? slot : PER_ROW - 1 - slot) * (NODE_W + GAP_X)
      const offset = (bandH - (col.length * NODE_H + (col.length - 1) * GAP_Y)) / 2
      col.forEach((s, ri) => pos.set(s.stepId, { x, y: y0 + offset + ri * (NODE_H + GAP_Y) }))
    }
    y0 += bandH + GAP_Y * 2.5
  })
  return pos
}

function pipelineCanvas(run, onOpen) {
  const steps = run.steps ?? []
  if (!steps.length) return null
  const ns = 'http://www.w3.org/2000/svg'
  const svgEl = (tag, attrs = {}, text) => {
    const n = document.createElementNS(ns, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v))
    if (text !== undefined) n.textContent = text
    return n
  }

  const auto = autoLayout(steps)
  const saved = savedLayout(run)
  const pos = new Map(steps.map((s) => [s.stepId, saved[s.stepId] ?? auto.get(s.stepId)]))
  const ids = new Set(steps.map((s) => s.stepId))
  const edges = steps.flatMap((s) => (s.inputsFrom ?? []).filter((f) => ids.has(f)).map((f) => ({ from: f, to: s.stepId })))

  const svg = svgEl('svg', { class: 'canvas', role: 'img', 'aria-label': 'pipeline graph' })
  const defs = svgEl('defs')
  const marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
  marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrow' }))
  defs.appendChild(marker)
  svg.appendChild(defs)
  const world = svgEl('g', { class: 'world' })
  svg.appendChild(world)
  const edgeLayer = svgEl('g', { class: 'edges' })
  const nodeLayer = svgEl('g', { class: 'nodes' })
  world.append(edgeLayer, nodeLayer)

  const edgePath = (e) => {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (b.x >= a.x + NODE_W - 8) {
      // Target to the right: leave from the right edge, arrive at the left.
      const x1 = a.x + NODE_W
      const y1 = a.y + NODE_H / 2
      const x2 = b.x
      const y2 = b.y + NODE_H / 2
      const mx = (x1 + x2) / 2
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
    }
    // Target below or behind (a wrapped band): leave from the bottom, arrive at the top.
    const x1 = a.x + NODE_W / 2
    const y1 = a.y + NODE_H
    const x2 = b.x + NODE_W / 2
    const y2 = b.y
    const my = (y1 + y2) / 2
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
  }
  const edgeEls = edges.map((e) => {
    const p = svgEl('path', { d: edgePath(e), class: 'edge', 'marker-end': 'url(#arrow)' })
    p.dataset.from = e.from
    p.dataset.to = e.to
    edgeLayer.appendChild(p)
    return { e, p }
  })
  const redrawEdges = (id) => {
    for (const { e, p } of edgeEls) if (!id || e.from === id || e.to === id) p.setAttribute('d', edgePath(e))
  }

  const nodeText = (step) => {
    const a = stepAnalytics(step)
    const bits = []
    if (a.in !== undefined || a.out !== undefined) bits.push(flowText(a))
    if (a.costUsd !== undefined) bits.push(formatCost(a.costUsd))
    if (a.durationMs !== undefined && step.status !== 'running') bits.push(formatMs(a.durationMs))
    return bits.join(' · ')
  }
  const nodeEls = new Map()
  const drawNode = (step) => {
    const p = pos.get(step.stepId)
    const g = svgEl('g', { class: 'node', 'data-status': step.status, 'data-step': step.stepId, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button' })
    g.appendChild(svgEl('rect', { width: NODE_W, height: NODE_H, rx: 10 }))
    g.appendChild(svgEl('circle', { class: 'dot', cx: 14, cy: 20, r: 4 }))
    g.appendChild(svgEl('text', { x: 26, y: 24, class: 'name' }, step.stepId))
    const title = step.title ? svgEl('text', { x: 26, y: 40, class: 'title' }, step.title.length > 30 ? `${step.title.slice(0, 29)}…` : step.title) : null
    if (title) g.appendChild(title)
    g.appendChild(svgEl('text', { x: 26, y: title ? 55 : 44, class: 'sub' }, nodeText(step)))
    const t = svgEl('title')
    t.textContent = `${step.stepId} — ${step.status}${step.title ? ` · ${step.title}` : ''}\nclick to open · drag to move`
    g.appendChild(t)
    nodeLayer.appendChild(g)
    nodeEls.set(step.stepId, g)
    return g
  }
  for (const s of steps) drawNode(s)

  // ── viewport: pan + zoom ──
  const view = { x: 24, y: 24, k: 1 }
  const apply = () => world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`)
  const bounds = () => {
    const xs = [...pos.values()]
    return { w: Math.max(...xs.map((p) => p.x)) + NODE_W, h: Math.max(...xs.map((p) => p.y)) + NODE_H }
  }
  const fit = () => {
    const box = svg.getBoundingClientRect()
    const b = bounds()
    const k = Math.min(1, (box.width - 48) / b.w, (box.height - 48) / b.h)
    view.k = Math.max(0.35, k)
    view.x = Math.max(24, (box.width - b.w * view.k) / 2)
    view.y = Math.max(24, (box.height - b.h * view.k) / 2)
    apply()
  }
  apply()

  svg.addEventListener('wheel', (event) => {
    event.preventDefault()
    const box = svg.getBoundingClientRect()
    const mx = event.clientX - box.left
    const my = event.clientY - box.top
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
    const k = Math.min(2.5, Math.max(0.3, view.k * factor))
    view.x = mx - ((mx - view.x) * k) / view.k
    view.y = my - ((my - view.y) * k) / view.k
    view.k = k
    apply()
  }, { passive: false })

  // ── dragging: a node moves itself, the background pans ──
  let drag = null
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const node = event.target.closest('.node')
    drag = { node, id: node?.dataset.step, x: event.clientX, y: event.clientY, start: node ? { ...pos.get(node.dataset.step) } : { x: view.x, y: view.y }, moved: false }
    try {
      svg.setPointerCapture(event.pointerId)
    } catch {
      // A synthetic event has no pointer to capture; dragging still works for real ones.
    }
  })
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    if (drag.node) {
      const p = { x: drag.start.x + dx / view.k, y: drag.start.y + dy / view.k }
      pos.set(drag.id, p)
      drag.node.setAttribute('transform', `translate(${p.x},${p.y})`)
      redrawEdges(drag.id)
    } else {
      view.x = drag.start.x + dx
      view.y = drag.start.y + dy
      apply()
    }
  })
  const endDrag = (event) => {
    if (!drag) return
    const { node, id, moved } = drag
    drag = null
    if (node && moved) {
      const layout = savedLayout(run)
      layout[id] = pos.get(id)
      try {
        localStorage.setItem(layoutKey(run), JSON.stringify(layout))
      } catch {}
    } else if (node && !moved) onOpen(id)
  }
  svg.addEventListener('pointerup', endDrag)
  svg.addEventListener('pointercancel', () => (drag = null))
  svg.addEventListener('keydown', (event) => {
    const node = event.target.closest?.('.node')
    if (node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      onOpen(node.dataset.step)
    }
  })

  const toolbar = el(
    'div',
    { class: 'canvas-bar' },
    el('span', { class: 'hint', text: 'drag a step to move it · drag the background to pan · scroll to zoom · click a step to open it' }),
    el('button', { type: 'button', class: 'quiet', text: 'Fit' }),
    el('button', { type: 'button', class: 'quiet', text: 'Reset layout' })
  )
  const [fitBtn, resetBtn] = toolbar.querySelectorAll('button')
  fitBtn.addEventListener('click', fit)
  resetBtn.addEventListener('click', () => {
    try {
      localStorage.removeItem(layoutKey(run))
    } catch {}
    const fresh = autoLayout(steps)
    for (const [id, p] of fresh) {
      pos.set(id, p)
      nodeEls.get(id)?.setAttribute('transform', `translate(${p.x},${p.y})`)
    }
    redrawEdges()
    fit()
  })

  const section = el('section', { class: 'pipeline' }, el('h2', { text: 'Pipeline' }), toolbar, el('div', { class: 'canvas-wrap' }, svg))
  // The canvas is as tall as the graph needs, within reason; then fit.
  svg.style.height = `${Math.min(640, Math.max(300, bounds().h + 56))}px`
  requestAnimationFrame(fit)

  currentCanvas = {
    update(step) {
      const g = nodeEls.get(step.stepId)
      if (!g) return
      g.setAttribute('data-status', step.status)
      g.querySelector('.sub').textContent = nodeText(step)
      g.querySelector('title').textContent = `${step.stepId} — ${step.status}${step.title ? ` · ${step.title}` : ''}\nclick to open · drag to move`
    },
    select(id) {
      for (const [k, g] of nodeEls) g.classList.toggle('selected', k === id)
    }
  }
  return section
}

// ── drawer: one step, opened from the canvas ────────────────────────────────

let drawer = null

function closeDrawer() {
  if (!drawer) return
  drawer.close()
  currentCanvas?.select(null)
  drawer = null
}

function openDrawer(run, stepsById, stepId, initialTab = 'step') {
  const current = new Map((run.steps ?? []).flatMap((step) => [step, ...(step.branches ?? [])]).map((step) => [step.stepId, step]))
  if (!current.has(stepId) && stepsById.has(stepId)) current.set(stepId, stepsById.get(stepId))
  if (!current.has(stepId)) return
  closeDrawer()
  drawer = openStepInspector({ run, stepsById: current, stepId, el, renderMarkdown, formatMs, formatBytes, renderCheck: checkItem, initialTab,
    onSelect: (id) => currentCanvas?.select(id),
    onClose: () => { currentCanvas?.select(null); drawer = null }
  })
}

function artifactItem(artifact) {
  const href = `/api/runs/${encodeURIComponent(currentRunId ?? '')}/artifacts/${artifact.path.split('/').map(encodeURIComponent).join('/')}`
  const link = el('a', { href, target: '_blank', rel: 'noopener', text: artifact.path })
  // A markdown artifact — a card, a report, a note — reads in place; a plain click
  // opens the reader, a modifier or middle click still gets the raw file.
  if (/\.(md|markdown)$/i.test(artifact.path)) {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      openReader(href, artifact.path)
    })
  }
  return el('li', {}, link, el('span', { class: 'kind', text: ` · ${formatBytes(artifact.bytes)}` }))
}

// ── reader: a markdown artifact, opened in place ────────────────────────────

let reader = null

function closeReader() {
  if (!reader) return
  reader.root.remove()
  document.removeEventListener('keydown', reader.onKey, true)
  reader = null
}

async function openReader(href, title) {
  closeReader()
  const body = el('div', { class: 'reader-body' }, el('p', { class: 'loading', text: 'Loading…' }))
  const root = el(
    'div',
    { class: 'reader-root' },
    el('div', { class: 'reader-backdrop' }),
    el(
      'aside',
      { class: 'reader', role: 'dialog', 'aria-label': title },
      el(
        'div',
        { class: 'reader-head' },
        el('span', { class: 'reader-title', text: title }),
        el('a', { class: 'quiet-link', href, target: '_blank', rel: 'noopener', text: 'raw ↗' }),
        el('button', { type: 'button', class: 'quiet close', text: '×', title: 'close (Esc)' })
      ),
      body
    )
  )
  root.querySelector('.close').addEventListener('click', closeReader)
  root.querySelector('.reader-backdrop').addEventListener('click', closeReader)
  // Captured, so Esc closes the reader and not the drawer underneath it.
  const onKey = (event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    closeReader()
  }
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(root)
  reader = { root, onKey }
  root.querySelector('.close').focus()
  try {
    const response = await fetch(href)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const text = await response.text()
    if (reader?.root === root) body.replaceChildren(renderMarkdown(text, el))
  } catch (err) {
    if (reader?.root === root) body.replaceChildren(el('p', { class: 'none', text: `could not load ${title}: ${err.message}` }))
  }
}

function describeCheck(check) {
  if (check.type === 'artifact') return check.path ?? 'artifact'
  return check.run ?? 'command'
}

function checkExpectation(check) {
  const wants = []
  if (check.expect_exit !== undefined && check.expect_exit !== 0) wants.push(`exit ${check.expect_exit}`)
  if (check.expect_match) wants.push(`match “${check.expect_match}”`)
  if (check.contains) wants.push(`contains “${check.contains}”`)
  return wants.length ? wants.join(', ') : null
}

// ── data ────────────────────────────────────────────────────────────────────

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? `request failed (${response.status})`)
  return body
}

// ── the run index ───────────────────────────────────────────────────────────

function runRow(run, index) {
  return el(
    'a',
    { class: 'run-row', href: `/runs/${encodeURIComponent(run.runId)}`, 'data-link': '', 'data-status': run.status, style: `--i:${index}` },
    el(
      'div',
      { class: 'run-name' },
      el('h2', { text: run.workflow }),
      el('div', { class: 'run-id', text: run.runId })
    ),
    el('span', { class: 'stamp', 'data-status': run.status, text: run.status }),
    el(
      'div',
      { class: 'run-when' },
      el('div', { text: formatWhen(run.startedAt) }),
      el('div', { class: 'dur', text: run.status === 'running' ? 'running' : run.status === 'interrupted' ? 'interrupted' : formatMs(durationMs(run.startedAt, run.finishedAt)) })
    )
  )
}

async function renderIndex(version) {
  const runs = await getJson('/api/runs')
  if (version !== renderVersion) return []
  document.title = 'flora — runs'

  if (!runs.length) {
    return [
      el(
        'div',
        { class: 'empty' },
        el('h2', { text: 'No runs yet' }),
        el('p', {}, 'Record one with ', el('code', { text: 'flora run examples/hello.yaml' }), ' and it will show up here.')
      )
    ]
  }

  return [
    el(
      'div',
      { class: 'page-head' },
      el('h1', { text: 'Runs' }),
      el('span', { class: 'count', text: `${runs.length} recorded` })
    ),
    el('div', { class: 'runs' }, runs.map(runRow))
  ]
}

// ── one run ─────────────────────────────────────────────────────────────────

function fact(label, value) {
  if (value === null || value === undefined || value === '') return null
  return el('span', {}, el('span', { class: 'label', text: label }), el('span', { text: value }))
}

function metaCell(label, value, extra) {
  return el('div', extra ?? {}, el('span', { class: 'label', text: label }), el('div', { class: 'value', text: value }))
}

function checkItem(result) {
  // Live events carry pass/fail and detail only; the contract itself arrives
  // with the finished record.
  const spec = result.check
  const expectation = spec ? checkExpectation(spec) : null
  return el(
    'li',
    { class: 'check', 'data-passed': String(result.passed) },
    el('span', { class: 'check-mark', text: result.passed ? '✓' : '✗' }),
    spec
      ? el(
          'span',
          { class: 'check-what' },
          el('span', { class: 'kind', text: `${spec.type ?? 'check'} · ` }),
          describeCheck(spec),
          expectation ? el('span', { class: 'kind', text: ` — expects ${expectation}` }) : null
        )
      : el('span', { class: 'check-what', text: result.detail ?? '' }),
    spec && result.detail ? el('span', { class: 'check-detail', text: result.detail }) : null
  )
}

function stepItem(step, index) {
  const evidence = step.evidence ?? {}
  const checks = step.checks ?? []
  const passedCount = checks.filter((c) => c.passed).length
  const running = step.status === 'running'
  const branches = step.branches ?? null
  const branchesPassed = branches ? branches.filter((b) => b.status === 'passed').length : 0
  const patches = (step.patches ?? []).filter(Boolean)
  const renderedRun = currentRunRecord
  const inspect = el('button', { type: 'button', class: 'inspection-action step-inspect-button', text: 'Inspect', 'aria-label': `Inspect ${step.stepId}` })
  inspect.addEventListener('click', () => {
    if (renderedRun && renderedRun === currentRunRecord) openDrawer(renderedRun, new Map([[step.stepId, step]]), step.stepId)
  })

  return el(
    'li',
    { class: 'step', style: `--i:${index}`, 'data-step': step.stepId },
    el('span', { class: 'node', 'data-status': step.status, text: MARK[step.status] ?? '·' }),
    el(
      'div',
      { class: 'step-head' },
      el('h3', { text: step.title || step.stepId }),
      el('span', { class: 'stamp', 'data-status': step.status, text: step.status }),
      evidence.stalled ? el('span', { class: 'stamp', 'data-status': 'stalled', text: 'stalled' }) : null,
      evidence.timedOut ? el('span', { class: 'stamp', 'data-status': 'stalled', text: 'timed out' }) : null,
      step.title ? el('span', { class: 'step-title', text: step.stepId }) : null,
      inspect
    ),
    el('details', { class: 'run-details step-execution-details' }, el('summary', { text: 'Execution details' }), el(
      'div',
      { class: 'facts' },
      fact('Executor', step.harness),
      fact('Attempt', step.attempt > 1 ? `${step.attempt} (retried)` : String(step.attempt ?? 1)),
      running ? null : fact('Took', formatMs(evidence.durationMs)),
      running ? null : fact('Exit', evidence.exitCode === null || evidence.exitCode === undefined ? 'none' : String(evidence.exitCode)),
      evidence.costUsd !== undefined ? fact('Cost', `$${Number(evidence.costUsd).toFixed(4)}`) : null,
      fact('Tokens', describeUsage(evidence.usage)),
      evidence.sessionId ? fact('Session', evidence.sessionId) : null,
      evidence.usage?.limitPct !== undefined ? fact('Limit', `${evidence.usage.limitPct}%`) : null,
      branches ? fact('Branches', `${branchesPassed}/${branches.length} passed`) : null,
      step.verifiedIn === 'worktree' ? fact('Verified in', 'a worktree of HEAD') : null,
      patches.length ? fact('Patches', String(patches.length)) : null,
      branches ? null : checks.length ? fact('Checks', `${passedCount}/${checks.length} passed`) : running ? null : fact('Checks', 'none')
    )),
    step.outputError ? el('p', { class: 'error', text: `Output contract: ${step.outputError}` }) : null,
    step.error ? el('p', { class: 'error', text: step.error }) : null,
    step.skipReason ? el('p', { class: 'facts', text: `Skipped — when: ${step.skipReason}` }) : null,
    step.priorAttempts?.length
      ? el(
          'p',
          { class: 'facts attempts' },
          'Earlier attempts: ',
          step.priorAttempts
            .map((a) => `#${a.attempt} ${a.status}${a.evidence ? ` (${formatMs(a.evidence.durationMs)}${a.evidence.costUsd !== undefined ? `, ${formatCost(a.evidence.costUsd)}` : ''}${a.evidence.stalled ? ', stalled' : ''}${a.evidence.timedOut ? ', timed out' : ''})` : ''}`)
            .join(' · ')
        )
      : null,
    step.prompt
      ? el('details', { class: 'evidence' }, el('summary', { text: 'Prompt · as sent' }), el('pre', { text: step.prompt }))
      : null,
    step.command
      ? el('details', { class: 'evidence' }, el('summary', { text: 'Command · as run' }), el('pre', { text: step.command }))
      : null,
    step.artifacts?.length
      ? el(
          'details',
          { class: 'evidence', open: step.artifacts.length <= 12 },
          el('summary', { text: `Artifacts · ${step.artifacts.length} file${step.artifacts.length === 1 ? '' : 's'}, ${formatBytes(step.artifacts.reduce((s, a) => s + a.bytes, 0))}` }),
          el(
            'ul',
            { class: 'artifacts' },
            ...step.artifacts.slice(0, 200).map(artifactItem),
            step.artifacts.length > 200 ? el('li', { class: 'kind', text: `… and ${step.artifacts.length - 200} more` }) : null
          )
        )
      : null,
    branches ? el('ol', { class: 'stem branches' }, branches.map((branch, i) => stepItem(branch, i))) : null,
    checks.length ? el('details', { class: 'evidence' }, el('summary', { text: `Verification details · ${passedCount}/${checks.length} passed` }), el('ul', { class: 'checks' }, checks.map(checkItem))) : null,
    step.output !== undefined && step.output !== null
      ? el(
          'details',
          { class: 'evidence' },
          el('summary', { text: 'Raw step result' }),
          el('pre', { text: typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2) })
        )
      : null,
    branches
      ? null
      : el(
          'details',
          { class: 'evidence executor-output', open: running },
          el('summary', { text: running ? 'Executor output · live' : 'Executor output' }),
          evidence.output || running
            ? el('pre', { text: evidence.output ?? '' })
            : el('div', { class: 'none', text: 'No output captured' })
        )
  )
}

function runPage(run, live) {
  const params = Object.entries(run.params ?? {})
  const failed = (run.steps ?? []).find((step) => step.status === 'failed')
  const running = run.status === 'running'
  // The page is a list of nodes handed to append(); a bare null there would
  // become the text "null", so an absent usage block is left out entirely.
  const usage = usageTable(run)
  const analytics = analyticsBlock(run)
  const stepsById = new Map((run.steps ?? []).map((s) => [s.stepId, s]))
  const canvas = pipelineCanvas(run, (id) => openDrawer(run, stepsById, id))
  const review = failed ? el('button', { type: 'button', class: 'inspection-action', text: 'Review the failed step' }) : null
  review?.addEventListener('click', () => openDrawer(run, stepsById, failed.stepId))
  const report = running ? null : el('a', { class: 'report-link', href: `/api/runs/${encodeURIComponent(run.runId)}/report.md`, text: 'Read report', title: 'Open the saved run report' })
  report?.addEventListener('click', (event) => { event.preventDefault(); void openReader(report.href, run.workflow + ' · report') })
  const guidance = failed ? 'This run stopped before completion. Review the failed step; its partial results are available, but the workflow did not finish.' : running ? 'The workflow is running. Open a step to follow its progress. Completed steps keep their saved results.' : run.status === 'passed' ? 'Open a step to read its input and result. Calls connects each recorded request with its prompt and answer; Files contains the saved documents.' : 'This run is incomplete. Open its steps to review the saved progress and verification details.'

  return [
    el('a', { class: 'back', href: '/', 'data-link': '', text: 'Runs' }),
    el(
      'div',
      { class: 'page-head' },
      el('h1', { text: run.workflow }),
      el('span', { class: 'stamp stamp-lg', 'data-status': run.status, text: run.status }),
      failed ? el('span', { class: 'count', text: `stopped at ${failed.stepId}` }) : null,
      running && live ? el('span', { class: 'live', text: 'Live' }) : null,
      report
    ),
    el('section', { class: 'run-guidance', 'data-status': run.status }, el('p', { text: guidance }), review),
    el('div', { class: 'meta' }, metaCell('Started', formatWhen(run.startedAt)), metaCell('Duration', running ? formatMs(Date.now() - Date.parse(run.startedAt)) : formatMs(durationMs(run.startedAt, run.finishedAt)), { 'data-duration': '' })),
    el('details', { class: 'run-details' }, el('summary', { text: 'Technical details · identifiers and parameters' }),
    el(
      'div',
      { class: 'meta' },
      metaCell('Run ID', run.runId),
      metaCell('Directory', run.cwd),
      run.trigger ? metaCell('Trigger', `${run.trigger.source} · ${run.trigger.id}`) : null,
      run.parentRunId ? metaCell('Parent run', run.parentRunId) : null,
      params.length ? metaCell('Parameters', params.map(([k, v]) => `${k}=${v}`).join('  ')) : null
    )),
    ...(canvas ? [canvas] : []),
    ...((analytics || usage) ? [el('details', { class: 'run-details' }, el('summary', { text: 'Run statistics · counts, time and reported usage' }), analytics, usage)] : []),
    (run.steps ?? []).length
      ? el('ol', { class: 'stem' }, run.steps.map(stepItem))
      : el('p', { class: running ? 'loading' : 'empty', text: running ? 'Waiting for the first step…' : 'This run recorded no steps.' })
  ]
}

// ── live updates ────────────────────────────────────────────────────────────

/** Keep at most this much of a step's streamed output on the page. */
const OUTPUT_TAIL_CHARS = 64 * 1024

let subscription = null

function unsubscribe() {
  if (!subscription) return
  subscription.source.close()
  clearInterval(subscription.clock)
  subscription = null
}

/**
 * Follow a run that is still going. The stream replays from the start, so the
 * steps are rebuilt from events rather than merged with the snapshot — that
 * keeps a reconnect idempotent. Once `run_end` arrives the finished record is
 * fetched whole, which is where evidence and the check contracts live.
 */
function subscribe(run) {
  unsubscribe()
  const steps = new Map()
  for (const step of run.steps ?? []) steps.set(step.stepId, { ...step, checks: [], evidence: {} })

  const stem = () => view.querySelector('.stem')

  const paint = (step) => {
    const savedIndex = run.steps.findIndex((saved) => saved.stepId === step.stepId)
    if (savedIndex >= 0) run.steps[savedIndex] = step
    else run.steps.push(step)
    const index = [...steps.keys()].indexOf(step.stepId)
    const fresh = stepItem(step, index)
    const existing = view.querySelector(`.step[data-step="${CSS.escape(step.stepId)}"]`)
    if (existing) existing.replaceWith(fresh)
    else {
      let list = stem()
      if (!list) {
        list = el('ol', { class: 'stem' })
        view.querySelector('.loading, .empty')?.replaceWith(list)
      }
      list.append(fresh)
    }
    // The graph and an open drawer follow the same state.
    currentCanvas?.update(step)
    if (drawer?.stepId === step.stepId) drawer.refresh(step)
  }

  const source = new EventSource(`/api/runs/${encodeURIComponent(run.runId)}/events`)

  source.addEventListener('step_start', (message) => {
    const data = JSON.parse(message.data)
    const step = steps.get(data.stepId) ?? { stepId: data.stepId }
    Object.assign(step, {
      title: data.title,
      harness: data.harness,
      attempt: data.attempt,
      status: 'running',
      checks: [],
      evidence: { output: '' }
    })
    steps.set(data.stepId, step)
    paint(step)
  })

  source.addEventListener('check_result', (message) => {
    const data = JSON.parse(message.data)
    const step = steps.get(data.stepId)
    if (!step) return
    step.checks.push({ passed: data.passed, detail: data.detail })
    paint(step)
  })

  source.addEventListener('step_result', (message) => {
    const data = JSON.parse(message.data)
    const step = steps.get(data.stepId)
    if (step && data.error) step.outputError = data.error
  })

  source.addEventListener('executor_output', (message) => {
    const data = JSON.parse(message.data)
    const step = steps.get(data.stepId)
    if (!step) return
    step.evidence.output = (step.evidence.output + data.chunk).slice(-OUTPUT_TAIL_CHARS)

    const pre = view.querySelector(`.step[data-step="${CSS.escape(data.stepId)}"] .executor-output pre`)
    if (!pre) return paint(step)
    // Follow the tail unless the reader has scrolled up to look at something.
    const pinned = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 12
    pre.textContent = step.evidence.output
    if (pinned) pre.scrollTop = pre.scrollHeight
    if (drawer?.stepId === step.stepId) drawer.refresh(step)
  })

  source.addEventListener('step_result', (message) => {
    const data = JSON.parse(message.data)
    const step = steps.get(data.stepId)
    if (!step) return
    step.status = data.status
    step.attempt = data.attempt ?? step.attempt
    paint(step)
  })

  source.addEventListener('run_end', () => {
    const restore = drawer ? { stepId: drawer.stepId, tab: drawer.tab } : null
    unsubscribe()
    void render(restore)
  })

  source.onerror = () => {
    // EventSource reconnects by itself with Last-Event-ID; nothing to do but
    // let the badge say so.
    view.querySelector('.live')?.setAttribute('data-state', source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
  }
  source.onopen = () => view.querySelector('.live')?.removeAttribute('data-state')

  const clock = setInterval(() => {
    const cell = view.querySelector('[data-duration] .value')
    if (cell) cell.textContent = formatMs(Date.now() - Date.parse(run.startedAt))
  }, 1000)

  subscription = { source, clock }
}

/** The run on screen — artifact links are built from it. */
let currentRunId = null
let currentRunRecord = null

async function renderRun(runId, version) {
  const run = await getJson(`/api/runs/${encodeURIComponent(runId)}`)
  if (version !== renderVersion) return []
  currentRunId = run.runId
  currentRunRecord = run
  document.title = `flora — ${run.workflow}`
  const live = run.status === 'running' && 'EventSource' in window
  const nodes = runPage(run, live)
  if (live) queueMicrotask(() => { if (version === renderVersion) subscribe(run) })
  return nodes
}

// ── routing ─────────────────────────────────────────────────────────────────

let renderVersion = 0

async function render(restore = null) {
  const version = ++renderVersion
  unsubscribe()
  closeDrawer()
  closeReader()
  currentRunRecord = null
  currentCanvas = null
  view.replaceChildren(el('p', { class: 'loading', text: 'Loading…' }))
  const match = /^\/runs\/([^/]+)\/?$/.exec(location.pathname)
  try {
    const nodes = match ? await renderRun(decodeURIComponent(match[1]), version) : await renderIndex(version)
    if (version === renderVersion) {
      view.replaceChildren(...nodes)
      if (restore && currentRunRecord) openDrawer(currentRunRecord, new Map(), restore.stepId, restore.tab)
    }
  } catch (err) {
    if (version !== renderVersion) return
    view.replaceChildren(
      el('a', { class: 'back', href: '/', 'data-link': '', text: 'Runs' }),
      el('p', { class: 'error', text: err.message })
    )
  }
}

document.addEventListener('click', (event) => {
  const guide = event.target.closest('a[data-guide]')
  if (guide && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
    event.preventDefault(); void openReader(guide.href, guide.textContent); return
  }
  const link = event.target.closest('a[data-link]')
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
  event.preventDefault()
  if (link.pathname === location.pathname) return
  history.pushState(null, '', link.href)
  void render()
})

window.addEventListener('popstate', () => void render())
void render()
