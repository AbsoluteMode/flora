import type { Evidence, Usage } from '../types'
import type { HarnessAdapter } from './types'
import { runCommand } from './command'
import { withOutputInstruction } from '../output'
import { attachUsage, parseUsage } from './usage'

/**
 * Harmonia's exact summary format is not pinned down in this repo (see #5), so
 * the universal parser does the work: JSON usage objects in any of the common
 * dialects, or a text footer such as `input=1200 output=340 limit=42%`.
 */
export function harmoniaUsage(output: string): Usage | undefined {
  return parseUsage(output)
}

/** Harmonia headless: `harmonia run --task "<prompt>" --cwd <cwd>`. */
export const harmoniaAdapter: HarnessAdapter = {
  name: 'harmonia',
  async execute(input): Promise<Evidence> {
    const args = [
      'run',
      '--task',
      withOutputInstruction(input.prompt ?? '', input.output),
      '--cwd',
      input.cwd,
      ...(input.spec.model ? ['--model', input.spec.model] : []),
      ...(input.spec.args ?? [])
    ]
    const evidence = await runCommand('harmonia', args, {
      ...input,
      timeoutMin: input.spec.timeout_min,
      stallMin: input.spec.stall_min
    })
    return attachUsage(evidence)
  }
}
