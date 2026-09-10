import { expect, it } from 'vitest'
import { connectionConfig } from '../connect'

it('generates shell-free JSON for a GUI host with spaces and Unicode paths', () => {
  const config = JSON.parse(connectionConfig('generic', 'E:\\Мои проекты', 'C:\\Program Files\\node.exe', 'C:\\Flora\\bin\\flora.mjs'))
  expect(config.mcpServers.flora).toEqual({ command: 'C:\\Program Files\\node.exe', args: ['C:\\Flora\\bin\\flora.mjs', 'mcp', '--cwd', 'E:\\Мои проекты'] })
})
it('escapes TOML backslashes and quotes without generating a shell command', () => {
  const config = connectionConfig('codex', '/tmp/a"b', '/bin/node', '/app/flora.mjs')
  expect(config).toContain('[mcp_servers.flora]')
  expect(config).toContain('"/tmp/a\\"b"')
})
it('refuses unknown configuration formats', () => {
  expect(() => connectionConfig('unknown', '/tmp')).toThrow(/client/)
})
