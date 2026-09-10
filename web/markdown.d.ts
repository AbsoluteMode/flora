// Types for web/markdown.js, so the parser can be tested from TypeScript.
export type InlineRun =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: InlineRun[] }
  | { t: 'em'; v: InlineRun[] }
  | { t: 'link'; v: InlineRun[]; href: string }

export type Block =
  | { type: 'heading'; level: number; inlines: InlineRun[] }
  | { type: 'paragraph'; inlines: InlineRun[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'rule' }
  | { type: 'quote'; inlines: InlineRun[] }
  | { type: 'list'; ordered: boolean; items: InlineRun[][] }
  | { type: 'table'; header: InlineRun[][]; align: Array<'left' | 'right' | 'center'>; rows: InlineRun[][][] }

export function parseInline(text: string): InlineRun[]
export function parseMarkdown(text: string): Block[]
export function renderMarkdown(text: string, el: (tag: string, props?: Record<string, unknown>, ...children: unknown[]) => unknown): unknown
