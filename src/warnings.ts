/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature and might
 * change at any time` the moment `node:sqlite` loads — two lines of noise on
 * every single CLI invocation, including in scripts that parse our output.
 *
 * `--disable-warning=ExperimentalWarning` would also hide it, but it is a blunt
 * instrument: it silences *every* experimental warning, so the day a dependency
 * starts using another unstable API we would never hear about it.
 *
 * Node's own printer is an ordinary 'warning' listener, so we can lift it off,
 * filter this one warning, and hand everything else straight back to it.
 *
 * Import this module before anything that pulls in `node:sqlite`.
 */

/** The one warning we hide — kept separate so it is testable without side effects. */
export function isSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')
}

let installed = false

export function silenceSqliteExperimentalWarning(): void {
  if (installed) return
  installed = true
  const printers = process.listeners('warning')
  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (isSqliteExperimentalWarning(warning)) return
    for (const printer of printers) printer(warning)
  })
}

silenceSqliteExperimentalWarning()
