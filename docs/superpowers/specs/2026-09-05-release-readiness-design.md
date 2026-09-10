# Flora installation and universal harness execution

The user requests a repository-free installer, reliable CLI and GUI harnesses, security and maintainability fixes, and Windows/macOS/Linux verification. Open issues were empty at intake. Existing acceptance criteria in issues #5 (timeouts, stdin EOF, process-tree cleanup, usage), #6 (only contract-declared MCP tools and bounded nesting), and #8 (schema, validation, execution through MCP) remain binding.

## Delivery

Ship platform distributions with a bundled Node runtime and the installed npm package. A Windows installer and macOS package provide native installation; Linux has a user-level installation script and portable archive. All packages execute outside the checkout, including in paths containing spaces. Generate checksums. Build and smoke-test artifacts on their native OS in CI before attaching them to a release. npm publication is a separate optional channel and must not prevent the standalone release when registry credentials are absent. Do not publish a release or merge without an explicit request.

## Harness boundary

Keep existing CLI adapters. Add `executor: { harness: external, client: <label> }` for an already-running agent in a GUI or any MCP client. A local persistent queue hands the prompt, cwd and output contract to the client. Claim tokens prevent competing workers from completing the same attempt. Timeouts, cancellation and stale claims must not leave a successful-looking run. Flora alone runs verification after the client submits evidence; a client cannot submit a passed verifier result.

Expose list/claim/heartbeat/complete tools through the authoring MCP server. A nonblocking `start_workflow` allows the same GUI agent to start a workflow, claim its step, do the work, submit the result and inspect the run. Keep synchronous `run_workflow` compatible for ordinary workflows. Step-scoped MCP servers must never expose unrestricted authoring/execution tools. Contract-declared MCP mounting is unsupported for external agents whose ambient tools Flora cannot restrict: reject it clearly instead of pretending isolation.

The integration works for clients supporting local stdio MCP and the tools needed by a particular task. It does not claim to automate arbitrary GUI applications, transfer desktop credentials to a CLI, or grant a remote web client access to localhost. Client labels route jobs; they do not prove application identity.

## Setup and diagnosis

Generate copyable MCP configuration using the current absolute Node and Flora paths, with an explicit working directory. Provide Codex TOML and generic/Claude JSON formats. Explain GUI setup and external execution with a runnable example. Doctor must distinguish unavailable CLI executors from the usable external/MCP path and must not report a failed probe as authenticated.

## Quality and evidence

Fix reproducible Windows baseline failures and source-backed security findings. Keep process launching, execution queue, MCP lifecycle and configuration formatting in separate focused modules. Add regression tests for actual failure modes, including completion ownership, cancellation, independent verification, argv safety and tool scope.

Run `npm test` and `npx tsc --noEmit` before pushing. CI runs native Windows, macOS and Linux tests plus installation smoke tests. Report unavailable live harnesses and unsigned native packages honestly. Work on `codex/installer-universal-harnesses`, created from `origin/main` at db18dce. Prepare a PR; any eventual merge uses squash.
