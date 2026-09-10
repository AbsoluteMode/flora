import { ChildProcess, spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runCommand } from '../adapters/command'

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn()
}))

let child: ChildProcess
let stdout: PassThrough
let stderr: PassThrough
beforeEach(() => {
  vi.useFakeTimers()
  stdout = new PassThrough()
  stderr = new PassThrough()
  // No OS process or PID: exercise the real runner's timers and stream handlers
  // without letting cold process startup become part of a 600 ms timer test.
  child = Object.assign(new ChildProcess(), { stdout, stderr })
  vi.mocked(spawn).mockReturnValue(child)
})
afterEach(() => {
  stdout.destroy()
  stderr.destroy()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('keeps a talking process alive beyond its initial stall deadline', async () => {
  const running = runCommand(process.execPath, [], { cwd: process.cwd(), timeoutMin: 0, stallMin: 0.6 / 60 })
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(150)
    const stream = i % 2 ? stderr : stdout
    stream.write(Buffer.from(`tick ${i}\n`))
  }
  child.emit('close', 0)
  const evidence = await running
  expect(evidence.durationMs).toBe(1200)
  expect(evidence.stalled).toBeUndefined()
  expect(evidence.exitCode).toBe(0)
  expect(evidence.output).toContain('tick 7')
})

it('expires the stall deadline after the last chunk when output stops', async () => {
  const running = runCommand(process.execPath, [], { cwd: process.cwd(), timeoutMin: 0, stallMin: 0.6 / 60 })
  await vi.advanceTimersByTimeAsync(500)
  stdout.write(Buffer.from('last activity\n'))
  await vi.advanceTimersByTimeAsync(601)
  child.emit('close', 0)
  const evidence = await running
  expect(evidence.durationMs).toBe(1101)
  expect(evidence.stalled).toBe(true)
  expect(evidence.exitCode).toBe(137)
})
