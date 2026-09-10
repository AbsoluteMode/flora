import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'
import { codexAdapter } from '../adapters/codex'

it('disables effective personal servers and mounts contract servers under fresh names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flora-codex-test-'))
  const script = join(dir, 'fixture.mjs')
  writeFileSync(script, `import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='mcp') console.log(JSON.stringify([{name:'personal.server',enabled:true}]));
else {fs.writeFileSync(process.env.FLORA_ARGV,JSON.stringify(args));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));}`)
  if (process.platform === 'win32') writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\fixture.mjs" %*\r\n')
  else { writeFileSync(join(dir, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(join(dir, 'codex'), 0o755) }
  try {
    const result = await codexAdapter.execute({ spec: { harness: 'codex' }, prompt: '--help', cwd: dir, env: { PATH: dir + delimiter + process.env.PATH, FLORA_ARGV: join(dir, 'args.json') }, mcp: [{ name: 'personal', command: 'node', args: ['server.mjs'], env: {} }] })
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('ok')
    const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[]
    expect(args).toContain('mcp_servers={"personal.server"={enabled=false}}')
    expect(args.some((a) => /^mcp_servers\.flora_[a-f0-9]{32}_personal=/.test(a))).toBe(true)
    expect(args.slice(-2)).toEqual(['--', '--help'])
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) }
})
