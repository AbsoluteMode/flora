import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Same filter the CLI installs — keeps the SQLite experimental warning out
    // of test output without hiding any other warning. See src/warnings.ts.
    setupFiles: ['./src/warnings.ts'],
    // Almost every test here spawns a real process — the CLI, a harness stub, a
    // server — so the 5s default is a stopwatch on process startup, not on the
    // code under test. On Windows a cold node start plus opening the journal can
    // take longer than that when the machine is busy, and the suite goes red for
    // no reason. The heavy end-to-end tests still set their own 60s/120s.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
