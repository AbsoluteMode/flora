# Step inspector validation

All committed examples and screenshots use synthetic data. User workflow bundles and real run files are not committed.

## Reproduce the browser checks

From the repository root:

```bash
node --import tsx scripts/preview-step-inspector.mts
```

This seeds a dedicated synthetic journal at `dist/step-inspector-preview` and serves it on localhost port 4191. Leave that process running. In another terminal, from `dist`:

```bash
npx --yes --package @playwright/cli playwright-cli -s=flora-inspector open http://127.0.0.1:4191/runs/inspector-example
npx --yes --package @playwright/cli playwright-cli -s=flora-inspector run-code --filename ../scripts/verify-step-inspector.js
```

The checks cover record selection/search, JSON views, call selection/search/filtering, failed responses and retry links, file previews, collections and pagination, missing and oversized files, Markdown and HTML-as-text, desktop/mobile/dark layouts, keyboard tabs, modal focus and incomplete historical evidence. Screenshots are written to `docs/screenshots/step-inspector*.png`.

Manual live validation appended real journal events through `RunStore`: output appeared in the open inspector and the final parsed result replaced the live text after `run_end`, preserving the selected step/tab. An earlier stale synthetic run correctly appeared as interrupted; live checks were repeated with a fresh run.

## Small real subscription test

A separate, untracked example used three invented reviews and the user's authorized Claude CLI subscription login (`authMethod: claude.ai`, subscription Max). A command node invoked Flora's actual `claudeCodeAdapter`, recording one logical CLI request with explicit input/task/response. CLI tools, MCP servers and hooks were disabled for this example, and API/provider overrides were removed only from that test process's environment.

The CLI reported `claude-haiku-4-5-20251001` and returned positive, negative and neutral classifications. A separate verification script checked all three original IDs and expected classifications, and Flora marked the run passed. Export produced a 5,358-byte `.flora-run` containing five artifacts. Import into a separate journal and browser inspection recovered the original three records, task, raw response and model. The original CLI invocation took about five seconds.

This validates a real local Windows Claude invocation and a portable completed result. It does not claim visibility into every internal provider request, nor does it establish native Claude execution on other operating systems. Platform tests and package installation are checked by the repository CI matrix.

## Screenshots

![Step input, command and output](../screenshots/step-inspector.png)
![Recorded call and retry](../screenshots/step-inspector-calls.png)
![Dark theme](../screenshots/step-inspector-dark.png)
![Narrow layout](../screenshots/step-inspector-mobile.png)
