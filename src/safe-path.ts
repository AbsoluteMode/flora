import { lstatSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Portable file names: refuse Windows devices, streams and ambiguous dot segments on every OS. */
export function validateRelativePath(value: string): void {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\\x00-\x1f:<>"|?*]/.test(value)) {
    throw new Error(`invalid relative path: ${String(value)}`)
  }
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`unsafe path segment: ${part}`)
    }
  }
}

export function validateFileName(value: string): void {
  validateRelativePath(value)
  if (value.includes('/')) throw new Error(`invalid file name: ${value}`)
}

/** Check before any read, write or recursive removal, including existing symlink/junction parents. */
export function containedPath(root: string, path: string): string {
  validateRelativePath(path)
  const base = resolve(root)
  const target = resolve(base, ...path.split('/'))
  const rel = relative(base, target)
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`path escapes its root: ${path}`)
  let cursor = base
  for (const part of ['', ...path.split('/')]) {
    cursor = part ? join(cursor, part) : cursor
    // lstat also catches broken links (existsSync does not).
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`unsafe symbolic link: ${cursor}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return target
}
