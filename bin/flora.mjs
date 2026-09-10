#!/usr/bin/env node
// Global/standalone entry: runs the installed TypeScript CLI through tsx.
import { delimiter, dirname } from 'node:path'

// Before anything else: the journal is `node:sqlite`, which is Node 22.5+. On an
// older Node the import below dies inside the module graph with a stack trace
// about a missing built-in — a person deserves the version and the fix instead.
{
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 5)) {
    process.stderr.write(
      `flora needs Node 22.5 or newer — this is v${process.versions.node}.\n` +
        `The run journal uses node:sqlite, a built-in that arrived in 22.5.\n` +
        `Install a current Node from https://nodejs.org and run flora again.\n`
    )
    process.exit(1)
  }
}

const { tsImport } = await import('tsx/esm/api')
// Steps can invoke `node` even when Flora is the machine's only Node installation.
process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`

// Order matters. ESM links the whole static graph — `node:sqlite` included —
// before any module body runs, so a plain `import './warnings'` inside cli.ts
// can lose the race and the warning still prints. Loading the filter as its own
// dynamic import forces it to finish first. See src/warnings.ts.
await tsImport('../src/warnings.ts', import.meta.url)
await tsImport('../src/cli.ts', import.meta.url)
