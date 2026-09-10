# Inspect a step

Open a run with `flora serve`, or open a received result with `flora open result.flora-run`.
Click a node in **Pipeline**, or **Inspect** on its step card.

- **Step** compares the recorded input and output, with the prompt alongside them for agent steps. A script's command is available under **How this step was run**. Source selectors choose between saved files and reported values. JSON and JSONL support Table / Record / JSON, collection selection, record search and paging. Click a table row to read its fields as a record and copy the item.
- **Calls** lists the requests a workflow recorded inside the step. Search by call label, model or an explicitly recorded item ID. Select a call to compare its input, task prompt and raw response; inspect usage, errors or a linked previous attempt.
- **Files** previews declared artifacts, including Markdown, without leaving the run. **Raw file** opens the complete saved file. Inline previews are limited to 2 MiB.
- **Checks** shows Flora's verification evidence, independently of the executor's response.

**View failed requests** opens the recorded failures directly. Long technical error messages remain under **Error details**, with a saved service message shown first when available. The run page explains incomplete results and keeps identifiers, parameters and statistics under expandable sections. **Help / Инструкция** in the header explains the reading and launch paths in English and Russian. New workflow execution still uses the CLI; the viewer does not offer a launch form.

On a narrow screen the panes stack. The step rail switches nodes, arrow keys switch tabs, and Escape closes the inspector. An open step follows live executor output and keeps its selected tab when the run finishes.

## Record inspectable evidence in any workflow

A step can be a command, script, agent or another supported executor. Flora records the step-level task and result. It does **not** automatically intercept every internal model request or file read by a CLI. To inspect those calls, the producing workflow must save them as declared artifacts.

For a portable result, save copies of the actual input data, prompts and responses at execution time. References to the producer's absolute paths are insufficient. Return the artifact folder in the step's JSON output:

```json
{"result":{"accepted":1},"artifacts":["evidence"]}
```

Place a descriptor named `inspection.json` in that folder:

```json
{
  "format": "flora-inspection",
  "version": 1,
  "inputs": [{"label":"Original records","artifact":"evidence/input.jsonl"}],
  "outputs": [{"label":"Classifications","artifact":"evidence/result.json"}],
  "calls": [{
    "callId":"classify-1",
    "label":"Record example-1",
    "recordIds":["example-1"],
    "status":"passed",
    "model":"model-reported-by-the-executor",
    "artifact":"evidence/call-1.json"
  }]
}
```

The referenced call file contains the actual recorded values:

```json
{
  "callId":"classify-1",
  "label":"Record example-1",
  "status":"passed",
  "backend":"claude-code",
  "request": {
    "system":"Classify the supplied review as positive, negative or neutral.",
    "user":"The product arrived broken."
  },
  "response": {
    "text":"negative",
    "model":"model-reported-by-the-executor",
    "usage":{"input_tokens":20,"output_tokens":1}
  }
}
```

`inputs` and `outputs` may use `value` for inline JSON instead of `artifact`. Calls may also be inline objects with `request` and `response`. Optional call fields include `error`, `phase`, `parentCallId`, `startedAt`, `finishedAt`, `settings`, and `request.transport`. Use `transport` to distinguish, for example, a logical CLI invocation from an individual provider request. Do not invent resolved model names or usage when the executor did not report them.

`request.systemFile` can reference a declared text artifact instead of inline `system`. `request.input` and `response.output` accept saved structured values. `recordIds` must describe known associations; matching labels alone is not proof that an item caused a response. `parentCallId` links a retry to its recorded earlier call. The call status is producer metadata; the **Checks** tab remains the separate verification evidence.

All referenced files must be included in the step's `artifacts`. References are relative paths with forward slashes. The viewer resolves only declared files in this run, refuses parent traversal and absolute paths, and does not open arbitrary producer files or remote URLs. Preview bytes are bounded even when size metadata is wrong. At most 16 descriptors and 2,000 calls are shown; larger histories remain available as raw files.

The viewer also reads the existing `capture/stages/*.json` input/output descriptors, `analysis/*/index.json` call indexes (`traceFile`, `mentionedIds`), and `traces/*/*.json` call files. This compatibility does not require a particular pipeline or data domain.

## Share and read an independent copy

```bash
flora export <run-id> --out result.flora-run
# On another machine:
flora open result.flora-run
```

The file carries the run record, event log and declared artifacts. The inspector reads those copied artifacts through the same run-scoped endpoint as local runs. It needs neither the producer's repository nor their subscription to read a completed result. To execute a new run, send the separate workflow `.flora` bundle; its local CLI executor uses the recipient's configured login.

When snapshots or calls were never recorded, the viewer says so. It may show saved upstream outputs or run parameters, explicitly labeled, but cannot recreate missing original inputs, prompts or responses. A pass marker alone establishes only the checks that were actually declared.
