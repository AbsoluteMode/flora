import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { seedInspectionFixture } from '../src/__tests__/inspection-fixture.ts'
import { startServer } from '../src/web/server.ts'

const home = resolve('dist/step-inspector-preview')
mkdirSync(home, { recursive: true })
const dbPath = seedInspectionFixture(home)
const server = await startServer({ port: 4191, dbPath })
writeFileSync(resolve(home, 'server.json'), JSON.stringify({ url: server.url, dbPath }))
console.log(server.url)
process.on('SIGINT', () => { void server.close() })
