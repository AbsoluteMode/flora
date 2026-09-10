import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from '../../web/markdown.js'

const text = (runs: ReturnType<typeof parseInline>): string =>
  runs.map((r) => (r.t === 'text' || r.t === 'code' ? r.v : text(r.v))).join('')

describe('the viewer reads a markdown artifact', () => {
  it('reads a signal card: heading, summary table with alignment, rule, list, fenced code', () => {
    const card = [
      '# item-01 — Проверка демонстрационного каталога',
      '',
      'вердикт: ready_for_review · score: 0.85',
      '',
      '---',
      '',
      '| signal_id | Что меняется | quality_score |',
      '|---|---|---:|',
      '| item-01 | Записи каталога прошли проверку | 0.85 |',
      '',
      '## Что делать',
      '',
      '- проверить каталог',
      '- посчитать записи',
      '  за две недели',
      '1. первый',
      '',
      '```json',
      '{"score": 0.85}',
      '```'
    ].join('\n')
    const blocks = parseMarkdown(card)
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'rule', 'table', 'heading', 'list', 'list', 'code'])

    const table = blocks[3]
    if (table.type !== 'table') throw new Error('expected a table')
    expect(table.header.map(text)).toEqual(['signal_id', 'Что меняется', 'quality_score'])
    expect(table.align).toEqual(['left', 'left', 'right'])
    expect(table.rows).toHaveLength(1)
    expect(text(table.rows[0][2])).toBe('0.85')

    const list = blocks[5]
    if (list.type !== 'list') throw new Error('expected a list')
    expect(list.ordered).toBe(false)
    // A wrapped item is one item.
    expect(list.items.map(text)).toEqual(['проверить каталог', 'посчитать записи за две недели'])

    const code = blocks[7]
    if (code.type !== 'code') throw new Error('expected code')
    expect(code).toMatchObject({ lang: 'json', text: '{"score": 0.85}' })
  })

  it('keeps identifiers with underscores as text and still marks real emphasis', () => {
    const runs = parseInline('signal_id и final_status — **важно**, _курсив_, `code_x` и *тоже*')
    expect(text(runs)).toBe('signal_id и final_status — важно, курсив, code_x и тоже')
    expect(runs.flatMap((r) => (r.t === 'em' ? [text(r.v)] : []))).toEqual(['курсив', 'тоже'])
    expect(runs.flatMap((r) => (r.t === 'strong' ? [text(r.v)] : []))).toEqual(['важно'])
    expect(runs.flatMap((r) => (r.t === 'code' ? [r.v] : []))).toEqual(['code_x'])
  })

  it('keeps markup that is not markdown as text — the renderer never sees HTML', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> and [click](javascript:alert(1))')
    expect(blocks).toHaveLength(1)
    const [p] = blocks
    if (p.type !== 'paragraph') throw new Error('expected a paragraph')
    expect(text(p.inlines)).toBe('<script>alert(1)</script> and click')
    // The link survives as a run; whether it becomes an <a> is the renderer's call (only http/https/mailto do).
    expect(p.inlines.find((r) => r.t === 'link')).toMatchObject({ href: 'javascript:alert(1)' })
  })

  it('never drops text: an unknown construct is a paragraph, CRLF is fine', () => {
    const blocks = parseMarkdown('first line\r\nsecond line\r\n\r\n> a quote\r\nstill quoted')
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'quote'])
    if (blocks[0].type !== 'paragraph' || blocks[1].type !== 'quote') throw new Error('unexpected shape')
    expect(text(blocks[0].inlines)).toBe('first line second line')
    expect(text(blocks[1].inlines)).toBe('a quote still quoted')
  })
})
