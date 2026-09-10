# Step inspection implementation plan

Work individually in Flora on `codex/step-inspector`, from current main. Do not edit other repositories or commit user run files. The user delegated design choices and authorized a small synthetic example through their logged-in Claude CLI.

Spec: `docs/decisions/2026-09-07-step-inspection.md`.

- [x] Write failing normalization/reference tests, implement the browser data adapter, verify malformed metadata, missing files, body limits and cancellation.
- [x] Implement record previews and the wide step inspector; connect graph/card actions and live refresh. Preserve existing Markdown reading.
- [x] Exercise native and imported synthetic runs in a real browser: data selection, call search/detail, errors, missing history, keyboard navigation and narrow layouts. Inspect screenshots. The real Claude example also passed independent checks and imported-file inspection.
- [x] Document the generic descriptor contract with synthetic examples. Run full tests/types and prepare the PR screenshots. Local verification: 345 tests, TypeScript, browser scenarios and a separate tarball installation passed.

Integration follows the user's standing rule: push the Flora branch, create a PR with screenshots, verify the Windows/macOS/Linux CI matrix, then squash into main.
