/**
 * Five-field cron, the 90% that real schedules use: `*`, every-n steps
 * (star, slash, n), ranges `a-b`, lists `a,b,c`, stepped ranges `a-b/n`.
 * No month or weekday names, no `L`/`W`/`#`. Local time. Parsing happens
 * when a workflow loads, so a typo fails at `flora watch` start, not at
 * nine o'clock on Monday.
 */
export interface CronSpec {
  expr: string
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  /** `*` in the day-of-month / day-of-week field; cron ORs the two only when both are restricted. */
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 }
]

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron "${expr}": expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`)
  }
  const sets = fields.map((field, i) => parseField(field, FIELDS[i], expr))
  const dayOfWeek = new Set([...sets[4]].map((d) => (d === 7 ? 0 : d)))
  return {
    expr,
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek,
    anyDayOfMonth: fields[2] === '*',
    anyDayOfWeek: fields[4] === '*'
  }
}

function parseField(text: string, field: { name: string; min: number; max: number }, expr: string): Set<number> {
  const values = new Set<number>()
  const fail = (why: string): never => {
    throw new Error(`cron "${expr}": ${field.name} field "${text}" ${why}`)
  }
  for (const part of text.split(',')) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part)
    if (!match) fail('is not a value, range, list or step')
    const [, startText, endText, stepText] = match!
    const step = stepText === undefined ? 1 : Number(stepText)
    if (step < 1) fail('has a step of 0')
    let start: number
    let end: number
    if (startText === '*') {
      start = field.min
      end = field.max
    } else {
      start = Number(startText)
      end = endText === undefined ? (stepText === undefined ? start : field.max) : Number(endText)
    }
    if (start < field.min || end > field.max || start > end) fail(`is outside ${field.min}-${field.max}`)
    for (let v = start; v <= end; v += step) values.add(v)
  }
  return values
}

/** The first moment strictly after `from` that matches. Throws if none within a year. */
export function nextCron(spec: CronSpec, from: Date): Date {
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  // Every iteration moves at least a minute forward; a year of minutes is the ceiling.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (!spec.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(spec, t)) {
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }
    if (!spec.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!spec.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1)
      continue
    }
    return t
  }
  throw new Error(`cron "${spec.expr}" never fires`)
}

function dayMatches(spec: CronSpec, t: Date): boolean {
  const dom = spec.dayOfMonth.has(t.getDate())
  const dow = spec.dayOfWeek.has(t.getDay())
  if (spec.anyDayOfMonth && spec.anyDayOfWeek) return true
  if (spec.anyDayOfMonth) return dow
  if (spec.anyDayOfWeek) return dom
  return dom || dow
}
