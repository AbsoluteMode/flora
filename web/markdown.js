// Markdown as the viewer shows it: a small, predictable subset — headings,
// paragraphs, lists, tables, fenced code, quotes, rules — read into blocks of
// inline runs. The parser never touches the DOM, so it is testable on its
// own; renderMarkdown() builds elements through the caller's builder, and
// the builder only ever sets text — a card written by a model stays text.

const FENCE = /^(`{3,}|~{3,})\s*(\S*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TABLE_RULE = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

/** Cells of one table row: a leading and trailing pipe are decoration, `\|` is a literal pipe. */
function cells(line) {
  const parts = []
  let cell = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '|') { cell += '|'; i++ }
    else if (ch === '|') { parts.push(cell); cell = '' }
    else cell += ch
  }
  parts.push(cell)
  if (parts.length && !parts[0].trim() && line.trimStart().startsWith('|')) parts.shift()
  if (parts.length && !parts[parts.length - 1].trim() && line.trimEnd().endsWith('|')) parts.pop()
  return parts.map((c) => c.trim())
}

function alignments(line) {
  return cells(line).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
}

/** Text with `**strong**`, `*em*`, `` `code` `` and `[text](url)` split into runs. */
export function parseInline(text) {
  const runs = []
  let plain = ''
  const flush = () => { if (plain) { runs.push({ t: 'text', v: plain }); plain = '' } }
  const boundary = (i) => i < 0 || i >= text.length || !/[\p{L}\p{N}_]/u.test(text[i])
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m
    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_{}\[\]()#+\-.!|>]/.test(text[i + 1])) { plain += text[i + 1]; i += 2; continue }
    if ((m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest))) { flush(); runs.push({ t: 'code', v: m[2].trim() }); i += m[0].length; continue }
    if ((m = /^\*\*(?=\S)([\s\S]+?\S)\*\*/.exec(rest))) { flush(); runs.push({ t: 'strong', v: parseInline(m[1]) }); i += m[0].length; continue }
    if (boundary(i - 1) && (m = /^__(?=\S)([\s\S]+?\S)__/.exec(rest)) && boundary(i + m[0].length)) { flush(); runs.push({ t: 'strong', v: parseInline(m[1]) }); i += m[0].length; continue }
    if ((m = /^\*(?=\S)([^*]+?\S)\*/.exec(rest))) { flush(); runs.push({ t: 'em', v: parseInline(m[1]) }); i += m[0].length; continue }
    // `_` only around a whole word: signal_id and final_status are identifiers, not emphasis.
    if (boundary(i - 1) && (m = /^_(?=\S)([^_]+?\S)_/.exec(rest)) && boundary(i + m[0].length)) { flush(); runs.push({ t: 'em', v: parseInline(m[1]) }); i += m[0].length; continue }
    if ((m = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/.exec(rest))) { flush(); runs.push({ t: 'link', v: parseInline(m[1]), href: m[2] }); i += m[0].length; continue }
    plain += text[i]
    i++
  }
  flush()
  return runs
}

/** The document as blocks. Unknown constructs read as paragraphs — never dropped. */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  const paragraph = []
  const closeParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join(' ')) })
    paragraph.length = 0
  }
  while (i < lines.length) {
    const line = lines[i]
    let m
    if (!line.trim()) { closeParagraph(); i++; continue }
    if ((m = FENCE.exec(line))) {
      closeParagraph()
      const fence = m[1]
      const body = []
      i++
      while (i < lines.length && !(lines[i].startsWith(fence[0].repeat(fence.length)) && !lines[i].slice(fence.length).trim())) body.push(lines[i++])
      i++ // the closing fence, when there is one
      blocks.push({ type: 'code', lang: m[2], text: body.join('\n') })
      continue
    }
    if ((m = HEADING.exec(line))) { closeParagraph(); blocks.push({ type: 'heading', level: m[1].length, inlines: parseInline(m[2]) }); i++; continue }
    if (RULE.test(line)) { closeParagraph(); blocks.push({ type: 'rule' }); i++; continue }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('|')) {
      closeParagraph()
      const header = cells(line).map(parseInline)
      const align = alignments(lines[i + 1])
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]).map(parseInline))
      blocks.push({ type: 'table', header, align, rows })
      continue
    }
    if ((m = LIST_ITEM.exec(line))) {
      closeParagraph()
      const ordered = /\d/.test(m[2])
      const items = []
      while (i < lines.length && (m = LIST_ITEM.exec(lines[i])) && /\d/.test(m[2]) === ordered) {
        let item = m[3]
        i++
        // A wrapped item continues on indented lines until the next marker or a blank line.
        while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && /^\s+/.test(lines[i])) item += ' ' + lines[i++].trim()
        items.push(parseInline(item))
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    if (line.startsWith('>')) {
      closeParagraph()
      const quoted = []
      while (i < lines.length && lines[i].trim() && (lines[i].startsWith('>') || !(FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) || LIST_ITEM.test(lines[i])))) quoted.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push({ type: 'quote', inlines: parseInline(quoted.join(' ')) })
      continue
    }
    paragraph.push(line.trim())
    i++
  }
  closeParagraph()
  return blocks
}

const SAFE_HREF = /^(https?:|mailto:)/i

function inlineNodes(runs, el) {
  return runs.map((run) => {
    if (run.t === 'text') return run.v
    if (run.t === 'code') return el('code', { text: run.v })
    if (run.t === 'strong') return el('strong', {}, ...inlineNodes(run.v, el))
    if (run.t === 'em') return el('em', {}, ...inlineNodes(run.v, el))
    if (run.t === 'link') {
      // Only web addresses become links; anything else reads as its text.
      return SAFE_HREF.test(run.href) ? el('a', { href: run.href, target: '_blank', rel: 'noopener' }, ...inlineNodes(run.v, el)) : el('span', {}, ...inlineNodes(run.v, el))
    }
    return ''
  })
}

/** The document as elements, built with the viewer's `el(tag, props, ...children)`. */
export function renderMarkdown(text, el) {
  const blocks = parseMarkdown(text)
  return el(
    'div',
    { class: 'md' },
    ...blocks.map((block) => {
      if (block.type === 'heading') return el(`h${block.level}`, {}, ...inlineNodes(block.inlines, el))
      if (block.type === 'paragraph') return el('p', {}, ...inlineNodes(block.inlines, el))
      if (block.type === 'code') return el('pre', {}, el('code', { text: block.text }))
      if (block.type === 'rule') return el('hr')
      if (block.type === 'quote') return el('blockquote', {}, ...inlineNodes(block.inlines, el))
      if (block.type === 'list') return el(block.ordered ? 'ol' : 'ul', {}, ...block.items.map((item) => el('li', {}, ...inlineNodes(item, el))))
      if (block.type === 'table') {
        return el(
          'div',
          { class: 'md-table' },
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, ...block.header.map((cell, c) => el('th', { 'data-align': block.align[c] ?? 'left' }, ...inlineNodes(cell, el))))),
            el('tbody', {}, ...block.rows.map((row) => el('tr', {}, ...row.map((cell, c) => el('td', { 'data-align': block.align[c] ?? 'left' }, ...inlineNodes(cell, el))))))
          )
        )
      }
      return null
    })
  )
}
