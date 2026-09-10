# Flora release readiness implementation plan

> Execute inline in the current task, with targeted regression checks and a final integrated review. The user requested no subagents and no connectors.

**Goal:** Install and operate Flora without a repository checkout from CLI and MCP-capable desktop clients on Windows, macOS and Linux.
**Architecture:** Bundle the existing runtime for distribution; retain CLI adapters and introduce a local claimed-work queue for existing GUI agents. Keep verification in the engine and generate client-specific connection configuration at the CLI boundary.
**Tech Stack:** Node 22.5+, TypeScript, SQLite, MCP SDK, Vitest, GitHub Actions.
**Spec:** `docs/superpowers/specs/2026-09-05-release-readiness-design.md`.

## Global constraints

- Preserve issues #5, #6 and #8 acceptance criteria, documented in the spec.
- Work on the feature branch from main; no changes to user authentication or app settings.
- Run `npm test` and `npx tsc --noEmit` successfully before push; PR for review; squash when merging is authorized.
- No claims of native-OS or live-model validation without actual evidence.

## Task 1: Standalone installation

Ownership: `scripts/`, `installers/`, `.github/workflows/`, `package.json`, package-lock changes required by packaging, `.gitignore`, packaging tests. Consume the installed `bin/flora.mjs` entrypoint, produce a distribution with its own Node and platform launchers. Build using the lockfile, preserve Node's license, include checksums, and smoke-test outside the checkout. Native installers and release upload must consume those tested payloads. npm publishing may use a token only when configured and must not block standalone release assets.

- [ ] Implement package staging and install smoke checks (`--version`, `doctor`, command workflow, MCP initialize/list tools).
- [ ] Implement Windows setup, macOS package, Linux user install/uninstall, and archives.
- [ ] Extend CI native OS matrix and release artifact assembly.
- [ ] Verify a built Windows payload locally and inspect every installed path; review packaging changes.

## Task 2: Universal external execution

Ownership: new `src/bridge/`, `src/adapters/external.ts`, `src/adapters/index.ts`, `src/adapters/types.ts`, `src/types.ts`, `src/workflow.ts`, `schema/workflow.schema.json`, `src/engine.ts`, `src/mcp/`, bridge and MCP tests. Produce `external` adapter and MCP tools `start_workflow`, `list_pending_steps`, `claim_step`, `heartbeat_step`, `complete_step` (final names documented with their schemas). Use SQLite transactions for claims; capability tokens for mutating a claim; bounded lifetime, cancellation and cleanup. Preserve synchronous execution APIs. Register only native step tools on a scoped server, fixing the existing unrestricted-tool exposure. Reject external tool mounts explicitly.

- [ ] Add failing tests for cross-process claim exclusivity, invalid token, duplicate/stale completion, abort and expiry.
- [ ] Implement queue and adapter with authoritative engine verification.
- [ ] Add nonblocking MCP workflow lifecycle and end-to-end MCP tests where the same client starts, claims and completes a verified workflow.
- [ ] Test scoped-server tool lists, nesting boundaries, workflow source/cwd handling and disconnect behavior.

## Task 3: CLI reliability and security fixes

Ownership: CLI adapters except external/registry/types, `src/tools.ts`, `src/doctor.ts`, corresponding runner/doctor/tools tests; coordinate MCP tests with Task 2. Investigate baseline 8 failed/242 passed before fixing. Reproduce with isolated scratch data. Inspect argv handling, npm shim resolution, environment propagation, stream error/usage semantics, model tool isolation and diagnostic probes. No live model calls until free local diagnostics establish readiness.

- [ ] Diagnose and fix baseline Windows failures; keep existing regression tests meaningful.
- [ ] Add focused tests before fixing each argv, auth or isolation defect.
- [ ] Run affected tests and typecheck; report remaining live-harness limitations.

## Task 4: Setup, integration and delivery

Ownership: `src/connect.ts`, `src/cli.ts`, connection tests, README and supporting documentation; source-backed archive/web fixes from the security audit as needed after coordinating owners.

- [ ] Generate MCP JSON/TOML with absolute executable/entrypoint/cwd and correct escaping for space/Unicode paths.
- [ ] Document installation, GUI/CLI matrix and external workflow example, including the difference between controlling Flora and acting as a step executor.
- [ ] Integrate security fixes, independently review the complete diff, run all required checks and package smoke tests.
- [ ] Push feature branch only after checks pass, open PR with accurate validation/limitations, inspect native-OS CI and fix failures.
