/** Readable fields, with a shared node budget for deeply nested saved values. */
export function recordView(value, el) {
  let remaining = 200
  const render = (item, depth = 0) => {
    if (--remaining < 0) return el('span', { class: 'inspection-hint', text: 'More fields available in JSON.' })
    if (item === null) return el('span', { class: 'record-empty', text: 'Empty value' })
    if (typeof item !== 'object') return el('div', { class: 'record-text', text: String(item) })
    if (depth >= 4) return el('pre', { class: 'data-code', text: JSON.stringify(item, null, 2) })
    const entries = Object.entries(item), list = el('dl', { class: 'record-fields' })
    for (const [key, child] of entries.slice(0, 50)) {
      if (remaining <= 0) break
      list.append(el('div', { class: 'record-field' }, el('dt', { text: Array.isArray(item) ? `Item ${Number(key) + 1}` : key }), el('dd', {}, render(child, depth + 1))))
    }
    if (entries.length > 50 || remaining <= 0) list.append(el('p', { class: 'inspection-hint', text: 'Open JSON to read all fields.' }))
    if (!entries.length) list.append(el('p', { class: 'record-empty', text: Array.isArray(item) ? 'Empty list' : 'No fields' }))
    return list
  }
  return render(value)
}
