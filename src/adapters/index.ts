import type { HarnessAdapter } from './types'
import { commandAdapter } from './command'
import { claudeCodeAdapter } from './claude-code'
import { codexAdapter } from './codex'
import { harmoniaAdapter } from './harmonia'
import { apiAdapter } from './api'

export type { ExecuteInput, HarnessAdapter } from './types'

const ADAPTERS: Record<string, HarnessAdapter> = {
  command: commandAdapter,
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  harmonia: harmoniaAdapter,
  api: apiAdapter
}

export function adapterFor(harness: string): HarnessAdapter {
  const adapter = Object.hasOwn(ADAPTERS, harness) ? ADAPTERS[harness] : undefined
  if (!adapter) throw new Error(`no adapter for harness "${harness}"`)
  return adapter
}
