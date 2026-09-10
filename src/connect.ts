import { join } from 'node:path'
import { PACKAGE_ROOT } from './version'

/** Generate configuration only: never rewrite an application's settings or credentials. */
export function connectionConfig(client: string, cwd: string, node = process.execPath, entry = join(PACKAGE_ROOT, 'bin', 'flora.mjs')): string {
  const args = [entry, 'mcp', '--cwd', cwd]
  if (client === 'codex') return `[mcp_servers.flora]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}\n`
  if (client === 'generic' || client === 'claude-desktop' || client === 'claude-code') return JSON.stringify({ mcpServers: { flora: { command: node, args } } }, null, 2) + '\n'
  throw new Error('unknown client; use codex, claude-desktop, claude-code or generic')
}
