# Inspect a step's inputs, task and result together

## Problem and acceptance

An analyst can currently find a step's status and stdout, but discovering its actual records, prompt and reply requires expanding unrelated sections and finding files by name. A successful exit or a summary counter does not explain the result.

The user approved designing this within Flora. Workflow bundles and real run files are user data, not source fixtures to commit. Committed fixtures use synthetic data. The user subsequently authorized a small real test with their logged-in Claude CLI; that test and its result stay outside tracked source. Work is performed without subagents.

Acceptance follows the read-only localhost viewer requirements in issues #2 and #3:

- Both a graph node and an explicit Inspect button open the same step inspector.
- Input, recorded prompt/command and output are visible together on a desktop; compact screens remain usable.
- Calls are searchable/selectable and expose recorded request/response, model, usage, errors and repair links.
- JSON/JSONL records can be read as a table or JSON, searched, selected and copied. Markdown artifacts retain the existing reader.
- Missing snapshots, missing files and incomplete model history have distinct honest states. No data is reconstructed by guessing or by reading the producer's workspace.
- Imported `.flora-run` files work through the same declared-artifact routes. No new executable endpoint or external network request is introduced.
- `npm test`, `npx tsc --noEmit`, browser checks and PR screenshots pass before push; squash integration follows CI.

## References and design

n8n separates node input/output and exposes execution history and AI execution details. Its item linking is explicit; labels alone do not establish lineage. References: [data](https://docs.n8n.io/data/), [execution history](https://docs.n8n.io/workflows/executions/all-executions/), [mapping UI](https://docs.n8n.io/data/data-mapping/data-mapping-ui/), [item linking](https://docs.n8n.io/data/data-mapping/data-item-linking/item-linking-node-building/).

Keep Flora's existing neutral palette (`#fafaf8`, white, `#f3f3f1`, `#1d1d1f`, coral `#d97757`, green `#1f9d55`) and system font. Monospace is for code/data. Spend the layout change on a wide inspection workspace, not decorative cards or new branding.

```
steps       step title / status / executor          close
            Step | Calls | Files | Checks
            Input          Prompt / Command        Output
            source picker  recorded task            source picker
            table / JSON   copy                     table / JSON
```

Calls add a bounded searchable table above the three panes. Files have a searchable inventory and an inline preview. Step navigation, keyboard focus, cancellation of stale loads and responsive stacking are part of the interface.

## Data boundary

Use the current run record and declared artifacts only. A pure browser data adapter recognizes generic inspection/call descriptors and the existing `capture/stages/*.json`, `analysis/*/index.json`, `traces/*/*.json` conventions. None of these readers contains pipeline names or domain-specific record IDs.

Native step prompts/commands and outputs remain useful without traces. Upstream results and run parameters are labeled as such; they are not falsely presented as snapshots of files an agent read. Native agent execution is not counted as one internal model call.

Only exact, uniquely resolved declared artifact references may be fetched through the current run's API. Metadata and preview bodies are bounded, file loads are cancellable, and invalid data is rendered as text or an explicit error. All DOM rendering uses text nodes; the existing Markdown reader remains responsible for supported formatting.

## Implementation boundaries

- `web/inspection-data.js`: safe reference resolution, bounded readers, source/call normalization.
- `web/data-view.js`: reusable record/table/JSON/text preview.
- `web/step-inspector.js` and scoped CSS: navigation, tabs, call selection, files, checks and accessibility.
- `web/app.js`: open/close integration and live refresh, keeping graph and run-list behavior.
- Synthetic unit/browser fixtures and documentation describe how any workflow can supply inspectable data.

The engine and journal schema are outside this viewer change. Rich information cannot appear for calls the producing workflow never recorded.
