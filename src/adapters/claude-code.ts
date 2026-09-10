import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Evidence, Usage } from '../types'
import type { ExecuteInput, HarnessAdapter } from './types'
import { runCommand } from './command'
import { withOutputInstruction } from '../output'
import { allowedToolPatterns, claudeMcpConfig } from '../tools'
import { parseUsage } from './usage'

/** The terminal frame of `--output-format stream-json`. */
interface ClaudeResultFrame {
  type: 'result'
  subtype?: string
  is_error?: boolean
  result?: string
  errors?: string[]
  total_cost_usd?: number
  usage?: Record<string, unknown>
}

export interface ClaudeStreamSummary {
  /** Text of the final answer, or the CLI's error list when it failed. */
  result?: string
  isError: boolean
  costUsd?: number
  usage?: Usage
}

/**
 * Pick the result out of a stream-json transcript. One JSON object per line;
 * anything that is not JSON (a banner, a warning) is skipped rather than
 * treated as a failure.
 */
export function parseClaudeStream(output: string): ClaudeStreamSummary | null {
  let result: ClaudeResultFrame | null = null
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const frame = JSON.parse(trimmed) as { type?: string }
      if (frame.type === 'result') result = frame as ClaudeResultFrame
    } catch {
      // partial or non-JSON line — ignore
    }
  }
  if (!result) return null

  if ((result.result !== undefined && typeof result.result !== 'string') ||
      (result.subtype !== undefined && typeof result.subtype !== 'string') ||
      (result.is_error !== undefined && typeof result.is_error !== 'boolean') ||
      (result.errors !== undefined && (!Array.isArray(result.errors) || !result.errors.every((error) => typeof error === 'string'))) ||
      (result.total_cost_usd !== undefined && (typeof result.total_cost_usd !== 'number' || !Number.isFinite(result.total_cost_usd)))) {
    return { isError: true, result: 'claude stream contains a malformed result frame' }
  }

  return {
    result: result.result ?? (result.errors?.length ? result.errors.join('\n') : undefined),
    isError: Boolean(result.is_error) || Boolean(result.subtype?.startsWith('error')),
    costUsd: result.total_cost_usd,
    usage: result.usage ? parseUsage(JSON.stringify({ usage: result.usage })) : undefined
  }
}

/**
 * Claude Code headless: `claude -p "<prompt>" --output-format stream-json --verbose`.
 *
 * stream-json rather than json on purpose: every assistant turn and tool
 * result is a line on stdout, so the stall timer in runCommand measures live
 * activity instead of one silent wait for a single JSON blob at the end.
 */
/** The command line for one step; `mcpConfigPath` is the file the step's servers were written to. */
export function claudeArgs(input: ExecuteInput, mcpConfigPath?: string): string[] {
  const servers = input.mcp ?? []
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    ...(input.spec.model ? ['--model', input.spec.model] : []),
    // Only the servers the contract lists — not whatever ~/.claude.json has —
    // and every tool they offer is pre-approved: a -p run cannot ask.
    ...(mcpConfigPath && servers.length
      ? ['--mcp-config', mcpConfigPath, '--allowedTools', allowedToolPatterns(servers).join(',')]
      : []),
    ...(input.spec.args ?? []),
    '--',
    withOutputInstruction(input.prompt ?? '', input.output)
  ]
}

export const claudeCodeAdapter: HarnessAdapter = {
  name: 'claude-code',
  async execute(input): Promise<Evidence> {
    let scratch: string | null = null
    let mcpConfigPath: string | undefined
    if (input.mcp?.length) {
      scratch = mkdtempSync(join(tmpdir(), 'flora-mcp-'))
      mcpConfigPath = join(scratch, 'mcp.json')
      writeFileSync(mcpConfigPath, claudeMcpConfig(input.mcp))
    }

    let evidence: Evidence
    try {
      evidence = await runCommand('claude', claudeArgs(input, mcpConfigPath), {
        ...input,
        timeoutMin: input.spec.timeout_min,
        stallMin: input.spec.stall_min
      })
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true })
    }

    const summary = parseClaudeStream(evidence.output)
    if (!summary) return evidence
    return {
      ...evidence,
      output: summary.result ?? evidence.output,
      costUsd: summary.costUsd,
      usage: summary.usage,
      exitCode: summary.isError ? 1 : evidence.exitCode
    }
  }
}
