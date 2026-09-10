# Quality, security and GUI verification

Status: source review and local fixes completed; release candidate 0.2.1. Baseline: `ad6392486abd9fdba30a481ef8e3d97e5fea8fb1` from `origin/main`. Native packaging and CI acceptance are recorded by the associated PR and tag workflows.

Scope: first-party runtime TypeScript, browser UI, workflow schema, installers, build/release scripts and their relevant tests. Third-party implementation is not exhaustively audited; dependency advisories are checked separately. Work is performed locally by one reviewer, without subagents or account connectors. Git operations use the user-selected AbsoluteEeezzy account.

## Acceptance and method

- Read applicable issue Definitions of Done before changing their behavior. Open issues were empty at intake.
- Trace untrusted workflow data, imported run/bundle data, model output, HTTP requests and MCP requests to parsing, execution, filesystem and journal operations.
- Separate source-confirmed defects from unproven concerns. Add reproductions before fixes and verify both intended behavior and failure handling.
- Record the actual files reviewed and verification performed; a green suite is not a substitute for source review or a real GUI session.
- Keep the shared project current, prepare fixes on a branch from main, run npm test and npx tsc --noEmit before push, and squash merge only after CI.

## Coverage

| Area | State | Evidence / pending work |
| --- | --- | --- |
| HTTP viewer / static files | Reviewed, fixed | `src/web/server.ts`, `src/safe-path.ts`; link containment, streaming cleanup, bounded HTTP limits, exact heartbeat lookup |
| Browser rendering / navigation | Reviewed, fixed | All of `web/app.js`, `web/index.html`, `web/styles.css`; corrupt layout recovery and stale navigation protection, browser smoke below |
| Workflow/schema/context | Reviewed, fixed | `workflow`, `contract`, `context`, `output`, `when`, workflow JSON Schema; early validation, own-property data maps |
| Engine / verifier / process lifecycle | Reviewed, fixed | `engine`, `verifier`, `adapters/command`, `git`; abort/drain exception paths and child output observers |
| MCP authoring and external worker queue | Reviewed, fixed | `mcp/server`, `mcp/background`, `connect`, `tools`, `bridge/queue`, `adapters/external`; capability claims, deadlines, cleanup, independent checks |
| CLI adapters and API providers | Reviewed, fixed | All `adapters/*.ts`, `providers`, `doctor`; malformed stream and usage handling. Live CLI authentication limitations below |
| Journal / recorder / reports / analytics | Reviewed, fixed | `state`, `recorder`, `report`, `analytics`, `usage`; full final record visibility, safe Markdown/Mermaid/CSV |
| Bundles / ZIP / run import-export | Reviewed, fixed | `bundle`, `zip`, `runfile`; import schema, event names, nesting limits, credential exclusions and glob matching |
| Triggers / cron / gates / Git | Reviewed, fixed | `triggers`, `cron`, `watch`, `gate`, `git`; poll cancellation/draining, shell quoting and hook ownership |
| Installation / release / dependencies | Reviewed | `installers/`, `scripts/`, both GitHub workflows, package/lock/tsconfig, `bin/flora.mjs`; locked standalone payload, checksums, install/uninstall boundaries |

The remaining runtime support modules (`cli`, `paths`, `types`, `version`, `warnings`) were also read. Coverage means source inspection and the stated checks, not a proof that every execution path is defect-free.

## GUI test state

Only Codex and Claude are in scope; Antigravity is excluded by user instruction.

- Native app discovery found Claude running in its Code tab and the OpenAI.Codex application branded ChatGPT. No test prompts or settings changes were sent through either GUI.
- The user offered to execute the real GUI checks. An isolated local test project is prepared at `E:\work projects\flora-gui-check`, with project-scoped MCP configuration, four validated workflow fixtures and exact per-client prompts. Its journal is isolated under `.state`.
- The user executed the tests in the real GUI applications. Read-only SQLite and filesystem readback independently confirmed the following runs, all with `harness: external`, cwd `E:\work projects\flora-gui-check`, unchanged workflow files and executor exitCode 0:

| GUI | Positive run (`passed`, file exists) | Negative run (`failed`, file missing) |
| --- | --- | --- |
| Claude | `1fb0d48e-b9b5-4913-8e30-fe9728217174` | `6785d6b5-296f-4b83-91b3-cd4304e8562d` |
| Codex | `c4474baa-62f6-4c8f-8c67-c7878baf13e5` | `d7a0a74b-0770-4664-93d1-c8655caf5e27` |

- Both positive files contain `FLORA_GUI_OK_10383152`; both negative files are absent. This confirms the basic real GUI handoff and independent verifier. It does not establish long-running recovery, every GUI version, standalone CLI authentication, or model execution without networking.
- Flora's external adapter uses the local queue instead of a model API or CLI adapter. The GUI model still uses the service configured by its own application; no fully offline-model claim is made.
- Official configuration references: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli> and <https://code.claude.com/docs/en/desktop#shared-configuration>.

## Validated findings and changes

| Finding / trigger | Before | Fix and evidence |
| --- | --- | --- |
| Malformed workflow or output schema | Wrong field types escaped validation; output schema errors could occur after executor side effects | Schema agreement checked at validation and engine entry; output schemas compile before any executor. `audit-validation`, `engine-failures` regressions |
| Prototype-named identifiers | Context serialization and template lookup disagreed for inherited keys such as `__proto__` | Null-prototype dictionaries and own-property lookup; provider, adapter and MCP config dictionaries handled consistently |
| Engine/observer exceptions | Parallel peers continued, context and work resources could leak; output observer exceptions escaped the command promise and crashed its host | Abort peers, await cleanup before rethrowing, close journal in finally, route output observer errors through the promise after termination |
| Early final journal status | MCP could return `passed` with an empty checks array while final cleanup was still awaited | `run_end` carries the complete verified record; recorder saves it before the terminal event. Synchronous readback regression plus real stdio MCP integration |
| SQLite writer contention | Deadline was checked before waiting for a lock, allowing late claim/heartbeat/completion | `BEGIN IMMEDIATE` precedes clock/expiry evaluation and mutation. Real worker-thread SQLite contention tests for all three operations |
| External task initial observer failure | Claimable task and database handle survived a thrown callback | Queue enqueue, callback and wait loop share guaranteed removal/close cleanup |
| Watcher stopping during a poll | `stop()` returned before poll completion; a late result could start work against a closed journal | Abort command/HTTP polling, bound Sentry requests, drain polling before close, reject late triggers; stop/start idempotency |
| Local viewer file links | Static/artifact directory links could expose files outside their declared root | Shared link-aware containment, tested with actual symlinks/junctions; stream pipeline destroys sources on disconnect and avoids second responses |
| HTTP limits and heartbeat lookup | Negative LIMIT exposed unlimited rows; old active runs depended on being in the latest 1000 | HTTP limit restricted to 1..1000; direct run summary lookup; HEAD event streams finish immediately |
| Bundle credential inclusion / glob bug | Default pack included common local credentials; `**` patterns were rewritten incorrectly | Exclude `.env*`, npm/netrc/pypirc/Git credential files and key/certificate files by default; single-pass glob translation |
| Untrusted run import | Malformed steps, metrics, costs and event names entered the journal and could break consumers or SSE framing | Runtime validation before any import mutation; finite numbers, portable paths, bounded nesting and event-name syntax; unknown fields retained for compatibility |
| Git hook path interpolation | Shell expanded `$()` inside paths; hooks depended on global Node PATH; a marker anywhere claimed hook ownership | POSIX single quoting, absolute active Node runtime, escaped metadata and precise ownership header. Executed real sh fixture with hostile filename and empty PATH |
| Markdown/Mermaid/CSV export | Labels/output could escape document syntax; formula-like CSV strings could be interpreted by spreadsheets; Mermaid IDs collided | Shared text/fence helpers, decimal Mermaid entities and distinct IDs, formula-like string cells exported as text. Report/share regressions |
| Malformed harness/provider output | Claude fields threw TypeErrors; Codex errors could become non-string evidence; provider JSON null threw; deeply nested usage overflowed the stack | Validate known frame fields, return ordinary failure evidence, iterative usage traversal and finite counters. All provider tests use fixtures, not paid APIs |
| Browser layout/navigation | Stored JSON null broke the entire run page; slower earlier requests could overwrite a later route | Validate coordinates and layout object, discard stale render results and subscriptions |

The filesystem/report findings affect local viewing or sharing boundaries; Flora still runs with the current OS user's permissions. They are not claims of unauthenticated remote code execution. Imported reports remain historical data supplied by their author, not attested proof of execution.

## Verification evidence

- Reproductions were run against the vulnerable behavior before fixes: validation, engine failure, sharing, import, SQLite contention, watcher stop, external cleanup, viewer containment and harness parser/observer cases.
- Full local Vitest run: **331 passing tests in 36 files**. `npx tsc --noEmit` and `node --check web/app.js` passed.
- `npm audit --omit=dev --json`: zero known advisories in the production dependency graph on 2026-09-05. This does not audit dependency implementations.
- Real browser (Playwright, Chromium): reproduced a run-page failure with `flora.layout.GUI verification = null`; after the fix the graph and independent checks render. Held the response for run A, navigated to run B, then released A: title and page stayed on B without page errors.
- [Viewer screenshot](screenshots/2026-09-05-viewer.png) uses synthetic audit data. It is evidence of the viewer smoke test, separate from the user's actual GUI-agent runs above.
- CI matrix: Windows x64, macOS arm64/x64, Linux arm64/x64 on Node 22.23.2, plus Linux Node 24 tests. Each native job builds a package and exercises installation/uninstallation and installed CLI/MCP smoke tests.
- Mermaid escaping follows the documented [decimal entity syntax](https://mermaid.js.org/syntax/flowchart.html#entity-codes-to-escape-characters).

## Operational limits and follow-up scope

- Live **Codex GUI and Claude GUI** basic positive/negative checks are confirmed on baseline ad63924. The changed implementation is covered by automated stdio MCP and lifecycle regressions; the user has not repeated every manual GUI scenario on 0.2.1.
- Live authenticated CLI model execution is not established on this machine: the observed Codex CLI rejected the existing `service_tier=default` user configuration, and Claude CLI had no authenticated login. User settings/authentication were not changed. CLI argv, stream parsing, cancellation and installed executable behavior have fixture/integration coverage.
- `harness: codex` / `claude-code` explicitly choose CLI; `harness: external` explicitly chooses an already connected MCP client. There is no automatic CLI-to-GUI fallback or GUI wake-up service. No Antigravity testing was performed.
- Workflows are rerunnable contracts with repeatable orchestration and explicit checks. They do not automatically pin repository state, model versions, complete GUI context, dependencies or external services. Bit-for-bit deterministic output is not guaranteed.
- Workflow authors and local OS processes are trusted to execute commands. Contract-mounted MCP tools do not constitute an OS sandbox. Memory/CPU budgets, hostile regular-expression isolation and protection against an OS user swapping files concurrently require a separate sandbox/resource-governance design.
- Watcher fingerprints persist, but its pending event queue is in memory. Crash-proof delivery/recovery, long-duration GUI reconnect/resume and automatic environment replay are not implemented or claimed by this audit.
- Less urgent usability limitations remain: CLI flag ordering/prefix selection and richer bundle manifest diagnostics. They are not treated as validated privilege-boundary vulnerabilities here.
- Packages cover the documented architectures and current CI runners; Linux requires glibc. Installers are unsigned. npm registry publication requires the repository's NPM_TOKEN configuration; GitHub release installers and npm tarball remain usable without it.

This completes a bounded single-reviewer audit and the fixes above, not a certification that Flora or all harness versions are free of vulnerabilities.
