import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where flora keeps its own files: the journal and per-run artifacts such as
 * branch patches. `FLORA_HOME` overrides; otherwise it follows `FLORA_DB`
 * (so a test's throwaway database gets throwaway artifacts next to it), and
 * finally `~/.flora`.
 */
export function floraHome(): string {
  if (process.env.FLORA_HOME) return process.env.FLORA_HOME
  if (process.env.FLORA_DB) return dirname(process.env.FLORA_DB)
  return join(homedir(), '.flora')
}
