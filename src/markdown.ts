/** Untrusted labels stay text, including when a report is opened in an HTML-capable renderer. */
export function markdownText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([`*_\[\]!|])/g, '\\$1').replace(/[\r\n]+/g, ' ')
}

function ticks(text: string, minimum: number): string {
  let length = minimum
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  return '`'.repeat(length)
}

export function codeSpan(text: string): string {
  const value = text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|')
  const delimiter = ticks(value, 1)
  const pad = /^[`\s]|[`\s]$/.test(value) ? ' ' : ''
  return `${delimiter}${pad}${value}${pad}${delimiter}`
}

export function codeFence(text: string, language: string): string[] {
  const delimiter = ticks(text, 3)
  return [delimiter + language, text, delimiter]
}
