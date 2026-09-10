import { createDataView } from './data-view.js'
import { filterCalls, loadCall, loadInspection, readableError, readArtifactText } from './inspection-data.js'

const valueSource = (label, value) => value === undefined ? [] : [{ key: label, label, value }]
const prettyExecutor = (name) => ({ 'claude-code': 'Claude Code', codex: 'Codex', command: 'Command', api: 'Model API', external: 'External agent' })[name] ?? name ?? 'Not recorded'

/** One inspection workspace. Navigation and loads are scoped to this open dialog. */
export function openStepInspector({ run, stepsById, stepId, el, renderMarkdown, formatMs, formatBytes, renderCheck, onClose, onSelect, initialTab = 'step' }) {
  const returnFocus = document.activeElement
  const oldOverflow = document.body.style.overflow
  const cache = new Map(), paneStates = new Map()
  let selected = stepId, tab = initialTab, info = null, panels = [], controller = null, detailController = null
  let revision = 0, detailRevision = 0, closed = false, selectedCall = '', query = '', status = 'all'
  let lastSignature = ''
  const name = el('h2', { id: 'step-inspector-title' })
  const facts = el('div', { class: 'inspection-facts' })
  const closeButton = el('button', { class: 'inspection-close', type: 'button', text: 'Close', 'aria-label': 'Close step inspector' })
  const sidebar = el('nav', { class: 'inspection-steps', 'aria-label': 'Workflow steps' })
  const tabs = el('div', { class: 'inspection-tabs', role: 'tablist', 'aria-label': 'Step details' })
  const content = el('div', { class: 'inspection-content', role: 'tabpanel', id: 'inspection-content' })
  const root = el('div', { class: 'inspector-root' }, el('div', { class: 'inspector-backdrop' }),
    el('section', { class: 'inspector', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'step-inspector-title' },
      el('header', { class: 'inspection-header' }, el('div', { class: 'inspection-heading' }, el('div', { class: 'inspection-workflow', text: run.workflow }), name, facts), closeButton),
      sidebar, el('div', { class: 'inspection-main' }, tabs, content)))

  const rawURL = (file) => `/api/runs/${encodeURIComponent(run.runId)}/artifacts/${file.path.split('/').map(encodeURIComponent).join('/')}`
  const active = () => stepsById.get(selected)
  const stateFor = (key) => { if (!paneStates.has(key)) paneStates.set(key, {}); return paneStates.get(key) }
  const read = async (file, signal = controller.signal) => {
    signal?.throwIfAborted()
    if (cache.has(file.path)) return cache.get(file.path)
    const text = await readArtifactText(run.runId, file, { signal: AbortSignal.any([controller.signal, signal]) })
    cache.set(file.path, text)
    return text
  }
  const pill = (value) => el('span', { class: 'stamp', 'data-status': value, text: value })
  const message = (text) => el('p', { class: 'inspection-message', text })
  const panel = (title, sources, options = {}) => {
    const view = createDataView({ el, title, sources, read, rawURL, onMarkdown: (text) => renderMarkdown(text, el), state: stateFor(`${selected}:${tab}:${title}`), ...options })
    view.title = title
    panels.push(view)
    return view.element
  }
  const grid = (...children) => el('div', { class: 'inspection-grid' }, ...children)

  function clearPanels() {
    for (const view of panels) view.destroy()
    panels = []
    detailRevision++; detailController?.abort()
  }
  function paintHeader() {
    const step = active()
    name.textContent = step.title || step.stepId
    facts.replaceChildren(pill(step.status ?? 'pending'), el('span', { text: step.stepId }), el('span', { text: prettyExecutor(step.harness) }), el('span', { text: `Attempt ${step.attempt ?? 0}` }))
    if (step.evidence?.durationMs !== undefined) facts.append(el('span', { text: formatMs(step.evidence.durationMs) }))
    sidebar.replaceChildren(el('div', { class: 'inspection-nav-title', text: `Steps · ${stepsById.size}` }))
    for (const [index, [id, candidate]] of [...stepsById.entries()].entries()) {
      const button = el('button', { type: 'button', class: id === selected ? 'inspection-step active' : 'inspection-step', 'aria-current': id === selected ? 'step' : undefined, 'aria-label': `Inspect step ${id}` },
        el('span', { class: 'inspection-step-order', text: String(index + 1) }), el('span', { class: 'inspection-step-name', text: candidate.title || id, title: candidate.title || id }), el('span', { class: 'inspection-status-dot', 'data-status': candidate.status, title: candidate.status }))
      button.addEventListener('click', () => { void selectStep(id); sidebar.querySelector('[aria-current="step"]')?.focus() })
      sidebar.append(button)
    }
  }
  function paintTabs() {
    tabs.replaceChildren()
    const checks = allChecks(active())
    const labels = [['step', 'Step', ''], ['calls', 'Calls', info?.calls.length ?? ''], ['files', 'Files', info?.artifacts.length ?? ''], ['checks', 'Checks', `${checks.filter((check) => check.passed).length}/${checks.length}`]]
    for (const [id, label, count] of labels) {
      const button = el('button', { type: 'button', role: 'tab', id: `inspection-tab-${id}`, 'aria-controls': 'inspection-content', 'aria-selected': tab === id, tabindex: tab === id ? '0' : '-1' }, el('span', { text: label }), count !== '' ? el('span', { class: 'inspection-tab-count', text: count }) : null)
      button.addEventListener('click', () => { tab = id; paintTabs(); paintContent(); tabs.querySelector('[aria-selected="true"]').focus() })
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = labels.findIndex(([key]) => key === id)
        tab = labels[event.key === 'Home' ? 0 : event.key === 'End' ? labels.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + labels.length) % labels.length][0]
        paintTabs(); paintContent(); tabs.querySelector('[aria-selected="true"]').focus()
      })
      tabs.append(button)
    }
    content.setAttribute('aria-labelledby', `inspection-tab-${tab}`)
  }
  function paintContent() {
    clearPanels(); content.replaceChildren()
    if (!info) { content.append(el('p', { class: 'loading', text: 'Loading saved step details…' })); return }
    for (const warning of info.warnings) content.append(message(warning))
    if (tab === 'calls') return paintCalls()
    if (tab === 'files') return paintFiles()
    if (tab === 'checks') return paintChecks()
    const step = active()
    const taskSources = step.command ? valueSource('Command as run', step.command) : valueSource('Recorded prompt', step.prompt)
    for (const branch of step.branches ?? []) taskSources.push(...valueSource(`Branch: ${branch.title || branch.stepId}`, branch.prompt ?? branch.command))
    const hint = info.inputOrigin === 'upstream' ? 'Saved outputs of preceding steps. Files read independently by the executor are shown only when captured.' : info.inputOrigin === 'parameters' ? 'Recorded run parameters. This run did not save input-file snapshots.' : ''
    if (info.calls.length) {
      const button = el('button', { type: 'button', class: 'inspection-primary', text: `Inspect ${info.calls.length} recorded ${info.calls.length === 1 ? 'call' : 'calls'}` })
      button.addEventListener('click', () => { tab = 'calls'; paintTabs(); paintContent() })
      content.append(el('div', { class: 'inspection-call-banner' }, el('span', { text: 'Compare the exact inputs, prompts and answers for each recorded call.' }), button))
      const failures = info.calls.filter((call) => call.status === 'failed').length
      if (failures) {
        const review = el('button', { type: 'button', class: 'inspection-action', text: 'View failed requests' })
        review.addEventListener('click', () => { tab = 'calls'; status = 'failed'; query = ''; selectedCall = ''; paintTabs(); paintContent() })
        const summary = step.status === 'passed' ? `This step passed its checks; ${failures} earlier ${failures === 1 ? 'request failed' : 'requests failed'}.` : `${failures} recorded ${failures === 1 ? 'request failed' : 'requests failed'}. Review these before using the result.`
        content.append(el('div', { class: 'inspection-problem', 'data-status': step.status }, el('span', { text: summary }), review))
      }
    }
    if (step.error || step.outputError) content.append(message(step.error || step.outputError))
    const input = panel('Input', info.inputs, { hint, empty: 'No input snapshot was recorded for this step.' })
    const output = panel('Output', info.outputs, { empty: step.status === 'running' ? 'The executor is running. Its output will appear as it is reported.' : 'No result was recorded for this step.' })
    if (step.command) {
      content.append(el('div', { class: 'inspection-grid inspection-grid-pair' }, input, output))
      content.append(el('details', { class: 'inspection-extra' }, el('summary', { text: 'How this step was run · command' }), panel('Command', taskSources)))
    } else content.append(grid(input, panel('Prompt', taskSources, { empty: 'No step prompt was saved. Check Calls for tasks performed inside the executor.' }), output))
  }
  function paintCalls() {
    if (!info.calls.length) {
      content.append(el('div', { class: 'inspection-empty-state' }, el('h3', { text: 'No individual calls recorded' }), el('p', { text: 'This run contains no saved per-call request/response records. The Step tab shows the prompt and output available for the overall execution.' })))
      return
    }
    const search = el('input', { type: 'search', value: query, placeholder: 'Search calls or record IDs…', 'aria-label': 'Search calls' })
    const select = el('select', { 'aria-label': 'Call result filter' }, [['all', 'All results'], ['passed', 'Passed'], ['failed', 'Failed'], ['running', 'Running'], ['unknown', 'Unknown']].map(([value, text]) => el('option', { value, text })))
    select.value = status
    const rowsRoot = el('div', { class: 'inspection-call-list' })
    const detail = el('div', { class: 'inspection-call-detail' })
    content.append(el('div', { class: 'inspection-toolbar' }, search, select), rowsRoot, detail)
    let page = Math.max(0, Math.floor(filterCalls(info.calls, query, status).findIndex((call) => call.key === selectedCall) / 25))
    const draw = () => {
      rowsRoot.replaceChildren()
      const filtered = filterCalls(info.calls, query, status)
      if (!filtered.length) {
        clearPanels(); detail.replaceChildren(); rowsRoot.append(el('p', { class: 'inspection-empty', text: 'No matching calls. Try another record ID or result filter.' })); return
      }
      const size = 25, visible = filtered.slice(page * size, (page + 1) * size)
      if (!visible.some((call) => call.key === selectedCall)) selectedCall = visible[0].key
      const body = el('tbody', {})
      for (const call of visible) {
        const button = el('button', { type: 'button', class: 'inspection-call-open', text: call.label, 'aria-pressed': selectedCall === call.key })
        button.addEventListener('click', () => { selectedCall = call.key; draw() })
        body.append(el('tr', { class: selectedCall === call.key ? 'selected' : '' }, el('td', {}, button), el('td', {}, pill(call.status)), el('td', { text: call.model || 'Not recorded' }), el('td', { text: call.phase || '—' })))
      }
      rowsRoot.append(el('table', { class: 'inspection-call-table' }, el('thead', {}, el('tr', {}, ['Call / record', 'Result', 'Model', 'Attempt'].map((text) => el('th', { text })))), body))
      const previous = el('button', { type: 'button', class: 'inspection-action', text: 'Previous calls', disabled: page === 0 })
      const next = el('button', { type: 'button', class: 'inspection-action', text: 'Next calls', disabled: (page + 1) * size >= filtered.length })
      previous.addEventListener('click', () => { page--; draw() }); next.addEventListener('click', () => { page++; draw() })
      rowsRoot.append(el('div', { class: 'data-pagination' }, el('span', { text: `${page * size + 1}–${page * size + visible.length} of ${filtered.length} calls` }), previous, next))
      void showCall(filtered.find((call) => call.key === selectedCall), detail)
    }
    search.addEventListener('input', () => { query = search.value; page = 0; draw() })
    select.addEventListener('change', () => { status = select.value; page = 0; draw() })
    draw()
  }
  async function showCall(call, detail) {
    clearPanels()
    const version = ++detailRevision
    detailController = new AbortController()
    detail.replaceChildren(el('p', { class: 'loading', text: 'Loading recorded call…' }))
    try {
      const data = await loadCall(call, info.artifacts, (file) => read(file, detailController.signal))
      if (closed || version !== detailRevision) return
      detail.replaceChildren()
      if (data.problem) { detail.append(message(data.problem)); return }
      const heading = el('div', { class: 'inspection-call-heading' }, el('h3', { text: data.label }), pill(data.status), el('span', { text: data.model || 'Model not recorded' }))
      if (data.backend) heading.append(el('span', { text: prettyExecutor(data.backend) }))
      if (data.startedAt && data.finishedAt) heading.append(el('span', { text: formatMs(Date.parse(data.finishedAt) - Date.parse(data.startedAt)) }))
      if (data.parentCallId) {
        const previous = info.calls.filter((item) => item.id === data.parentCallId)
        const link = el('button', { type: 'button', class: 'inspection-action', text: `Previous attempt: ${data.parentCallId}`, disabled: previous.length !== 1 })
        link.addEventListener('click', () => { selectedCall = previous[0].key; query = ''; status = 'all'; paintContent() })
        heading.append(link)
      }
      detail.append(heading)
      if (data.error) {
        const reason = readableError(data.error)
        detail.append(message(reason))
        if (reason !== data.error) detail.append(el('details', { class: 'inspection-extra' }, el('summary', { text: 'Error details' }), el('pre', { class: 'data-code', text: data.error })))
      }
      for (const warning of data.warnings ?? []) detail.append(message(warning))
      detail.append(grid(
        panel('Input', valueSource('Recorded user input', data.input)),
        panel('Prompt', valueSource('Recorded system / task prompt', data.prompt)),
        panel('Output', valueSource('Recorded response', data.output))
      ))
      if (data.usage || data.settings || data.transport) detail.append(el('details', { class: 'inspection-extra' }, el('summary', { text: 'Usage and execution settings' }), el('pre', { class: 'data-code', text: JSON.stringify({ usage: data.usage ?? null, settings: data.settings ?? null, transport: data.transport ?? null }, null, 2) })))
    } catch (error) {
      if (closed || version !== detailRevision) return
      detail.replaceChildren(message(error.message))
    }
  }
  function paintFiles() {
    const search = el('input', { type: 'search', placeholder: 'Find a file…', 'aria-label': 'Search files' })
    const list = el('div', { class: 'inspection-file-list' })
    const preview = el('div', { class: 'inspection-file-preview' }, el('p', { class: 'inspection-empty', text: 'Select a saved file to preview it.' }))
    content.append(el('div', { class: 'inspection-toolbar' }, search), el('div', { class: 'inspection-files' }, list, preview))
    const draw = () => {
      list.replaceChildren()
      const matches = info.artifacts.filter((file) => file.path.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))
      for (const file of matches.slice(0, 200)) {
        const button = el('button', { type: 'button', class: 'inspection-file' }, el('span', { text: file.path }), el('small', { text: Number.isFinite(file.bytes) ? formatBytes(file.bytes) : 'Size not recorded' }))
        button.addEventListener('click', () => { clearPanels(); preview.replaceChildren(panel('File', [{ key: file.path, label: file.path, artifact: file }])) })
        list.append(button)
      }
      if (!matches.length) list.append(el('p', { class: 'inspection-empty', text: 'No matching saved files.' }))
      if (matches.length > 200) list.append(el('p', { class: 'inspection-hint', text: `Showing 200 of ${matches.length} files. Use search to narrow the list.` }))
    }
    search.addEventListener('input', draw); draw()
  }
  function allChecks(step) {
    return [...(step.checks ?? []), ...(step.branches ?? []).flatMap((branch) => (branch.checks ?? []).map((check) => ({ ...check, branch: branch.stepId })))]
  }
  function paintChecks() {
    const step = active(), checks = allChecks(step)
    content.append(el('div', { class: 'inspection-check-intro' }, el('h3', { text: 'Independent verification' }), el('p', { text: 'Flora ran these checks against the result. Executor output alone does not prove that a step passed.' })))
    if (step.error || step.outputError) content.append(message(step.error || step.outputError))
    if (checks.length) content.append(el('ul', { class: 'checks inspection-checks' }, checks.map((check) => {
      const item = renderCheck(check)
      if (check.branch) item.prepend(el('span', { class: 'inspection-hint', text: check.branch }))
      return item
    })))
    else content.append(el('p', { class: 'inspection-empty', text: 'No verification checks were recorded for this step.' }))
    content.append(el('div', { class: 'inspection-check-facts' }, el('span', { text: `Executor exit code: ${step.evidence?.exitCode ?? 'not recorded'}` }), el('span', { text: `Attempts: ${step.attempt ?? 0}` })))
    for (const attempt of step.priorAttempts ?? []) content.append(el('p', { text: `Earlier attempt ${attempt.attempt}: ${attempt.status}` }))
  }
  async function selectStep(id) {
    const version = ++revision
    controller?.abort(); controller = new AbortController()
    if (selected !== id) { selectedCall = ''; query = ''; status = 'all' }
    selected = id; info = null; lastSignature = signature(active())
    paintHeader(); paintTabs(); paintContent(); onSelect?.(id)
    try {
      const loaded = await loadInspection(run, active(), (file) => read(file))
      if (closed || version !== revision) return
      info = loaded; paintTabs(); paintContent()
    } catch (error) {
      if (closed || version !== revision) return
      content.replaceChildren(message(error.message))
    }
  }
  const signature = (step) => JSON.stringify([step.status, step.attempt, step.prompt, step.command, step.artifacts?.length, step.checks?.length])
  function close() {
    if (closed) return
    closed = true; revision++; controller?.abort(); clearPanels(); root.remove()
    document.body.style.overflow = oldOverflow
    if (returnFocus?.isConnected) returnFocus.focus()
    onClose?.()
  }
  closeButton.addEventListener('click', close)
  root.querySelector('.inspector-backdrop').addEventListener('click', close)
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key !== 'Tab') return
    const nodes = [...root.querySelectorAll('button, a[href], input, select, [tabindex="0"]')].filter((node) => !node.disabled && node.getClientRects().length)
    const first = nodes[0], last = nodes.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  })
  document.body.append(root); document.body.style.overflow = 'hidden'
  void selectStep(stepId); closeButton.focus()
  return { root, get stepId() { return selected }, get tab() { return tab }, close, refresh(fresh) {
    stepsById.set(fresh.stepId, fresh)
    if (fresh.stepId !== selected) return
    if (signature(fresh) !== lastSignature) { cache.clear(); void selectStep(selected) }
    else if (tab === 'step') panels.find((pane) => pane.title === 'Output')?.updateText('executor', fresh.evidence?.output ?? '')
  } }
}
