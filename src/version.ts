import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where this flora lives and what it calls itself. The package root is the
 * anchor for everything shipped alongside the code — `bin/`, `web/`, `schema/`.
 */
export const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../..')

export function floraVersion(): string {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}

/**
 * Is this a checkout rather than an installed release? A published tarball has
 * no `.git`, so the directory answers it — and `npm link` is exactly the case
 * where the version number alone tells you nothing about what will run.
 */
export function isCheckout(): boolean {
  return existsSync(join(PACKAGE_ROOT, '.git'))
}
