/**
 * The `when:` condition of a step, evaluated after `{{…}}` substitution.
 * Deliberately tiny: `A == B`, `A != B`, `A` (truthy), `!A`. No arithmetic,
 * no nesting, no eval — a placeholder that did not resolve stays as written
 * and compares as text, which is what makes it visible in the skip reason.
 */
export interface WhenVerdict {
  holds: boolean
  /** The condition as evaluated, for the journal and the CLI. */
  reason: string
}

const FALSY = new Set(['', 'false', '0', 'null', 'undefined', 'no', 'off'])

/** Strip one layer of quotes so `'REVIEW_CLEAN'` and `REVIEW_CLEAN` mean the same. */
function literal(text: string): string {
  const t = text.trim()
  const quoted = /^(['"])(.*)\1$/.exec(t)
  return quoted ? quoted[2] : t
}

export function truthy(value: string): boolean {
  return !FALSY.has(literal(value).toLowerCase())
}

export function evaluateWhen(condition: string): WhenVerdict {
  const text = condition.trim()
  const compare = /^(.*?)\s*(==|!=)\s*(.*)$/.exec(text)
  if (compare) {
    const [, left, op, right] = compare
    const equal = literal(left) === literal(right)
    return { holds: op === '==' ? equal : !equal, reason: `${literal(left)} ${op} ${literal(right)}` }
  }
  if (text.startsWith('!')) {
    const operand = text.slice(1)
    return { holds: !truthy(operand), reason: `!${literal(operand)}` }
  }
  return { holds: truthy(text), reason: literal(text) }
}
