import { parsePreview } from './inspection-data.js'
import { recordView } from './record-view.js'

const json = (value) => JSON.stringify(value, null, 2) ?? ''
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
const cell = (value) => value === undefined ? '—' : value === null ? 'null' : Array.isArray(value) ? `[${value.length} items]` : record(value) ? `{${Object.keys(value).length} fields}` : String(value).slice(0, 180)

/** A bounded, read-only preview shared by step inputs, outputs and call evidence. */
export function createDataView({ el, title, sources = [], read, rawURL, onMarkdown, empty = 'Not recorded in this run.', hint = '', state = {} }) {
  let currentSources = sources, request = null, revision = 0, preview = null
  const picker = el('select', { class: 'data-source', 'aria-label': `${title} source` })
  const count = el('span', { class: 'data-count' })
  const copy = el('button', { type: 'button', class: 'inspection-action', text: 'Copy', title: `Copy ${title.toLowerCase()}` })
  const raw = el('a', { class: 'inspection-action', text: 'Raw file', target: '_blank', rel: 'noopener', hidden: true })
  const modes = el('div', { class: 'data-modes', role: 'group', 'aria-label': `${title} view` })
  const body = el('div', { class: 'data-body' })
  const notice = el('p', { class: 'inspection-hint', text: hint, hidden: !hint })
  const element = el('section', { class: 'inspection-pane', 'aria-label': title },
    el('div', { class: 'inspection-pane-head' }, el('h3', { text: title }), count, copy, raw), picker, notice, modes, body)
  let copiedText = ''

  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(copiedText); copy.textContent = 'Copied' }
    catch { copy.textContent = 'Select text to copy' }
  })
  picker.addEventListener('change', () => { state.sourceKey = picker.value; state.collection = ''; state.page = 0; state.query = ''; state.selected = null; void load() })

  function show() {
    copy.textContent = 'Copy'
    body.replaceChildren(); modes.replaceChildren()
    if (!preview) return
    const isJson = preview.kind === 'json'
    const available = isJson ? ['table', 'record', 'json', ...(preview.framed ? ['original'] : [])] : preview.kind === 'markdown' ? ['document', 'text'] : ['text']
    if (!available.includes(state.mode)) state.mode = available[0]
    for (const mode of available) {
      const button = el('button', { type: 'button', text: mode === 'json' ? 'JSON' : mode[0].toUpperCase() + mode.slice(1), 'aria-pressed': state.mode === mode, class: state.mode === mode ? 'active' : '' })
      button.addEventListener('click', () => { state.mode = mode; show() })
      modes.append(button)
    }
    const arrays = record(preview.value) ? Object.keys(preview.value).filter((key) => Array.isArray(preview.value[key])) : []
    if (arrays.length && isJson) {
      const select = el('select', { 'aria-label': `${title} collection` }, el('option', { value: '', text: 'Whole value' }), arrays.map((key) => el('option', { value: key, text: `${key} (${preview.value[key].length})` })))
      select.value = arrays.includes(state.collection) ? state.collection : ''
      state.collection = select.value
      select.addEventListener('change', () => { state.collection = select.value; state.page = 0; state.query = ''; state.selected = null; show() })
      modes.append(select)
    }
    const value = state.collection && arrays.includes(state.collection) ? preview.value[state.collection] : preview.value
    copiedText = isJson && state.mode !== 'original' ? json(value) : preview.text
    if (preview.problem) body.append(el('p', { class: 'inspection-message', text: preview.problem }))
    if (state.mode === 'document') {
      count.textContent = 'Document'
      body.append(onMarkdown(preview.text))
      return
    }
    if (state.mode === 'record') {
      const items = Array.isArray(value) ? value : [value]
      if (!items.length) { body.append(el('p', { class: 'inspection-empty', text: 'No records in this collection.' })); return }
      state.selected = Math.min(Math.max(0, state.selected ?? 0), items.length - 1)
      count.textContent = `Item ${state.selected + 1} of ${items.length}`
      copiedText = json(items[state.selected]); copy.textContent = 'Copy item'
      const number = el('input', { type: 'number', min: 1, max: items.length, value: state.selected + 1, 'aria-label': `${title} item number` })
      const selectItem = (index) => { state.selected = Math.min(Math.max(0, index), items.length - 1); show() }
      number.addEventListener('change', () => { if (Number.isInteger(Number(number.value))) selectItem(Number(number.value) - 1) })
      const previous = el('button', { type: 'button', class: 'inspection-action', text: 'Previous item', disabled: state.selected === 0 })
      const next = el('button', { type: 'button', class: 'inspection-action', text: 'Next item', disabled: state.selected === items.length - 1 })
      previous.addEventListener('click', () => selectItem(state.selected - 1)); next.addEventListener('click', () => selectItem(state.selected + 1))
      body.append(el('div', { class: 'record-navigation' }, previous, number, next), recordView(items[state.selected], el))
      return
    }
    if (state.mode !== 'table') {
      count.textContent = isJson && state.mode !== 'original' ? (Array.isArray(value) ? `${value.length} items` : '1 value') : `${preview.text.length.toLocaleString()} characters`
      body.append(el('pre', { class: 'data-code', tabindex: '0', text: copiedText || '(empty)' }))
      return
    }
    const rows = (Array.isArray(value) ? value : [value]).map((item, index) => ({ item, index }))
    count.textContent = `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`
    const search = el('input', { type: 'search', value: state.query ?? '', placeholder: 'Find a record or value…', 'aria-label': `Search ${title.toLowerCase()}` })
    const tableRoot = el('div', { class: 'data-table-root' })
    body.append(el('div', { class: 'data-search' }, search), tableRoot)
    const drawRows = () => {
      tableRoot.replaceChildren()
      const query = (state.query ?? '').trim().toLocaleLowerCase()
      const matches = query ? rows.filter(({ item }) => json(item).toLocaleLowerCase().includes(query)) : rows
      const pageSize = 15
      state.page = Math.min(state.page ?? 0, Math.max(0, Math.ceil(matches.length / pageSize) - 1))
      const page = matches.slice(state.page * pageSize, (state.page + 1) * pageSize)
      const keys = [...new Set(page.flatMap(({ item }) => record(item) ? Object.keys(item) : ['value']))]
      const columns = keys.slice(0, 8)
      if (!matches.length) { tableRoot.append(el('p', { class: 'inspection-empty', text: query ? 'No matching records.' : 'No items in this collection.' })); return }
      const tbody = el('tbody', {})
      for (const row of page) {
        const select = el('button', { type: 'button', class: 'data-row-select', text: String(row.index + 1), 'aria-label': `Inspect ${title.toLowerCase()} item ${row.index + 1}`, 'aria-pressed': state.selected === row.index })
        const tr = el('tr', { class: state.selected === row.index ? 'selected' : '' }, el('td', {}, select), columns.map((key) => {
          const field = record(row.item) ? (Object.hasOwn(row.item, key) ? row.item[key] : undefined) : row.item
          return el('td', {}, el('span', { class: 'data-cell-text', text: cell(field) }))
        }))
        tr.addEventListener('click', () => { state.selected = row.index; state.mode = 'record'; show(); body.querySelector('input')?.focus() })
        tbody.append(tr)
      }
      tableRoot.append(el('div', { class: 'data-table-scroll' }, el('table', { class: 'data-table' }, el('thead', {}, el('tr', {}, el('th', { text: '#' }), columns.map((key) => el('th', { text: key })))), tbody)))
      const previous = el('button', { type: 'button', class: 'inspection-action', text: 'Previous', disabled: state.page === 0 })
      const next = el('button', { type: 'button', class: 'inspection-action', text: 'Next', disabled: (state.page + 1) * pageSize >= matches.length })
      previous.addEventListener('click', () => { state.page--; state.selected = null; drawRows() }); next.addEventListener('click', () => { state.page++; state.selected = null; drawRows() })
      tableRoot.append(el('div', { class: 'data-pagination' }, el('span', { text: `${state.page * pageSize + 1}–${state.page * pageSize + page.length} of ${matches.length}` }), previous, next))
      if (keys.length > columns.length) tableRoot.append(el('p', { class: 'inspection-hint', text: `Showing ${columns.length} fields. Select an item or switch to JSON for all fields.` }))
      copiedText = json(value); copy.textContent = 'Copy'
    }
    search.addEventListener('input', () => { state.query = search.value; state.page = 0; state.selected = null; drawRows() })
    drawRows()
  }

  async function load() {
    const version = ++revision
    request?.abort(); request = new AbortController()
    preview = null; copy.disabled = true; raw.hidden = true; count.textContent = ''; modes.replaceChildren()
    const selected = currentSources.find((source) => source.key === state.sourceKey) ?? currentSources[0]
    state.sourceKey = selected?.key
    if (!selected) { body.replaceChildren(el('p', { class: 'inspection-empty', text: empty })); return }
    picker.value = selected.key
    if (selected.problem) { body.replaceChildren(el('p', { class: 'inspection-empty', text: selected.problem })); return }
    body.replaceChildren(el('p', { class: 'loading', text: 'Loading saved data…' }))
    try {
      let loaded
      if (selected.artifact) {
        raw.href = rawURL(selected.artifact); raw.hidden = false
        loaded = parsePreview(await read(selected.artifact, request.signal), selected.artifact.path)
      } else if (typeof selected.value === 'string') loaded = selected.plainText ? { kind: 'text', text: selected.value } : parsePreview(selected.value)
      else loaded = { kind: 'json', value: selected.value, text: json(selected.value) }
      if (version !== revision) return
      preview = loaded
      copy.disabled = false
      show()
    } catch (error) {
      if (version !== revision || request.signal.aborted) return
      body.replaceChildren(el('p', { class: 'inspection-empty', text: error.message }))
    }
  }

  function setSources(next) {
    currentSources = next
    picker.replaceChildren(...next.map((source) => el('option', { value: source.key, text: source.label })))
    picker.hidden = !next.length
    void load()
  }
  setSources(sources)
  return { element, setSources, updateText(key, value) {
    const source = currentSources.find((source) => source.key === key)
    if (!source) return
    source.value = value
    if (state.sourceKey !== key || preview?.kind !== 'text') return
    preview.text = value; copiedText = value
    count.textContent = `${value.length.toLocaleString()} characters`
    const pre = body.querySelector('.data-code')
    if (pre) {
      const pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 16
      pre.textContent = value
      if (pinned) body.scrollTop = body.scrollHeight
    }
  }, destroy() { revision++; request?.abort() } }
}
