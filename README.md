# flora

**Local-first workflow contracts for AI coding harnesses.**

Coding harnesses (Claude Code, Codex, Antigravity, …) are interactive tools. flora turns any of them into a **callable unit with a contract**: input (a step with a verification contract) → execution → output (evidence, judged by an independent verifier). In short: *it gives your harness an API.*

A workflow is a named, versioned YAML contract: which steps, executed by which harness with which model, and — the core idea — **what proves each step is actually done**. The verifier runs the checks itself; the executor never grades its own homework. The next step is not released until the current contract is closed.

Everything runs on your machine: your harnesses, your repos. The agents are the local harnesses you are
already logged into (Claude Code, Codex, Antigravity); an
API provider is never the default — a workflow that
wants one configures it explicitly. No cloud in the critical path.

## Quickstart

flora requires Node 22.5 or newer. Download the npm tarball from the
[latest release](https://github.com/AbsoluteMode/flora-public/releases/latest), then install it
— see [Installing flora](docs/installation.md):

```bash
npm install -g ./absolutemode-flora-0.6.3.tgz
flora doctor                         # which harnesses are installed and logged in, and what to fix
```

`flora doctor` names the version, where flora runs from, and every harness it found. Nothing else needs
installing: the executors are the tools you already have.

Your first contract — save it as `hello.yaml` and run it:

```yaml
name: hello
steps:
  - id: greet
    executor:
      harness: command
    run: 'echo "flora is up" > greeting.txt'
    verify:
      - type: artifact
        path: greeting.txt
        contains: flora is up
```

```bash
flora run hello.yaml
flora usage                          # what the last run spent: tokens and money per step
flora serve                          # browse past runs at http://127.0.0.1:4180
flora pack hello.yaml                # one file to hand to a colleague: flora run hello.flora
```

Every release carries the same package as a file: download `absolutemode-flora-<version>.tgz` from the release and
run `npm install -g ./absolutemode-flora-<version>.tgz` — the way in for a machine
without registry access.

Working from a checkout: `npm ci`, then `npm run flora -- …` in place of `flora …`. `flora doctor` says so
out loud, because a checkout runs whatever its working tree currently holds.

A contract looks like this:

```yaml
name: review-then-fix
params:
  task: { required: true }

steps:
  - id: implement
    executor: { harness: claude-code, timeout_min: 20, stall_min: 5 }
    prompt: |
      {{task}}
    verify:
      - type: command
        run: 'git diff --stat --exit-code'
        expect_exit: 1        # a non-empty diff must exist
    on_fail: { retry: 1 }

  - id: review
    executor: { harness: codex }
    prompt: Review the uncommitted changes; print REVIEW_CLEAN if no defects.
```

```bash
flora run review-then-fix.yaml --param task="fix the flaky retry in queue.ts"
```

Executors: `claude-code` (`claude -p --output-format stream-json`), `codex` (`codex exec --json`), `antigravity` (`agy --print --output-format stream-json`, Gemini models), `command` (any shell command). Checks: `command` (exit code / output match) and `artifact` (file exists / contains) — `llm-judge` and `human` gates are on the roadmap.

An **Antigravity** step (Google's `agy` CLI) names the model family and a reasoning level, which become the agy
model id, and says whether it may edit the run directory:

```yaml
  - id: review
    executor: { harness: antigravity, model: gemini-4-carbon, reasoning: high, access: read }
    prompt: Review the uncommitted changes and report a JSON verdict.
  - id: fix
    executor: { harness: antigravity, model: gemini-4-carbon, reasoning: medium, access: write }
    prompt: Fix the defect the review found.
```

`model` defaults to `gemini-4-carbon`, `reasoning` to `medium` (`gemini-4-carbon` + `high` → `gemini-4-carbon-high`;
a full id such as `gemini-4-carbon-low` is taken as is), and the id must be one `agy models` lists — otherwise the
step fails before any work. `access: read` (the default) runs `agy --sandbox` with commands, file writes, the
network and MCP denied; `access: write` adds `--mode auto`, edits stay inside the workspace and commands run in the
terminal sandbox. flora never passes `--dangerously-skip-permissions`, and refuses `executor.args` that set the
flags it owns (`--mode`, `--settings`, `--model`, …). The step's conversation id is journaled as its session
(`agy --conversation <id>` resumes it). Antigravity steps cannot mount `tools` yet.

Steps pass **data**, not just files. Declare `output: { type: json, schema: {…} }` and the value is parsed, validated and
journaled; later steps read it as `{{steps.fetch.output.items[0].id}}` in prompts and check expectations, and shell
steps read the whole context from the JSON file at `$FLORA_CONTEXT` (step outputs are never interpolated into shell
lines — see `examples/data-pipeline.yaml`).

An agent sees the schema in its prompt, and when its answer still breaks the contract — not JSON, no block, empty,
or a field of the wrong type — flora does not fail the step at once: it goes back to the **same agent, in the same
session** (`claude -p --resume`, `codex exec … resume`, `agy --conversation`), read-only and without tools, with the
validation errors as they are (path and reason) and the schema, and asks for the same result in the required form —
not for the work again. A harness that cannot resume a session (api) gets one fresh request quoting the
answer. `output_repair: { attempts: 2, timeout_min: 5 }` (the defaults) can be set for the whole workflow, a step or a
branch; `attempts: 0` turns it off. Each request has its own time limit (never above the step's `timeout_min`), its
time, tokens and money count towards the step, and the journal records it as `output_repair_start` /
`output_repair_result` events and `outputRepairs` on the step. flora never coerces types itself — the schema is the
author's contract; declare `anyOf` if either form is fine.

A step can also mount **tools** — `tools: [{ mcp: {…} }, { flora: call_workflow, workflow: ./review.yaml }, { flora: read_context }]` —
and the harness gets exactly those MCP servers and nothing else; `call_workflow` runs another contract as a nested
run and hands back its verdict (see `examples/review-with-tools.yaml`).

Steps form a graph: `needs: [lint]` waits for named steps (and lets independent ones run at once), `when: '{{steps.review.output.verdict}} == REVIEW_CLEAN'` skips a step whose condition does not hold; without `needs` the contract is the plain sequence it always was.

A step can fan out: `parallel: { require: quorum:2, branches: […] }` runs the branches at once, each in its own git
worktree of HEAD, hands back a patch per branch and the outputs as `{{steps.<id>.outputs}}` for a collector step
(see `examples/solve-and-collect.yaml`).

A contract can guard your pushes: `flora gate install examples/gate-review.yaml` installs a `pre-push` hook that runs
it and blocks the push when it fails (see `examples/gate-review.yaml` — a second harness reviews what is about to leave).

Contracts can run themselves: an `on:` block (`cron`, `sentry`, `command`) and `flora watch workflows/` fires them —
each new event exactly once, the event visible to the steps as `{{event.*}}` (see `examples/on-sentry.yaml`).

## Authoring with your agent

flora ships an MCP server, so the agent that will run your workflows can also write them — against the real contract,
not a guess at the YAML dialect:

```bash
claude mcp add flora -- node /path/to/flora/bin/flora.mjs mcp
```

For an installed package, `flora connect --client codex` (or `claude-code`, `claude-desktop`, `generic`) prints that
configuration with the absolute paths of the installed runtime and entrypoint, so nothing has to be typed by hand.

```toml
# ~/.codex/config.toml
[mcp_servers.flora]
command = "node"
args = ["/path/to/flora/bin/flora.mjs", "mcp"]
```

Tools: `describe_contract` (every field, generated from `schema/workflow.schema.json`), `validate_workflow` (errors with
the path of the offending field), `run_workflow`, `get_run`, `list_runs`. A typical exchange: *"make a node: prompt X,
I expect json with fields a and b"* → the agent writes the YAML → `validate_workflow` is green → `run_workflow` →
`get_run` to read the verdicts. The same schema gives you completion and inline errors in any editor with a YAML
language server — the examples start with `# yaml-language-server: $schema=…`.

## Design

- **Runner** — spawns the prescribed harness per step with its settings (model, timeout, args). Two timers guard
  every step: `timeout_min` caps wall-clock time, `stall_min` caps silence; either one kills the whole process
  tree and fails the step. stdin is closed, so a harness that stops to ask a question gets EOF, not a hang.
- **Verifier** — runs the step's checks itself and decides pass/fail; retries and fallbacks are part of the contract (`on_fail`).
  With `verify_in: worktree` the checks run in a fresh worktree of HEAD, so only what the executor committed can pass.
- **Engine** — walks the workflow, persists every run to a local journal (`~/.flora/flora.db`). A run whose flora
  process died (killed, crashed, machine off) is marked `interrupted` instead of showing as running forever.
  `flora run` stops cleanly on SIGINT, SIGTERM and SIGHUP — the step's process tree is killed and the run is journaled —
  and keeps going to its real result when whatever was reading its output goes away.
- **Step inspector** — click a pipeline node or **Inspect** to compare input, task and output, inspect saved calls and retries, search JSON/JSONL records, and read files and independent checks. It also works with imported `.flora-run` files. [Recording inspectable evidence](docs/step-inspection.md).
- **Viewer** — `flora serve` reads that journal and renders it at `127.0.0.1:4180`: every run, its
  steps, the evidence each executor left, and the verifier's verdict per check.
- **Usage** — every step's tokens and money land in the journal: Claude Code, Codex and Antigravity report
  their own, a `command` step is counted when it prints a JSON line with a `usage` object (`input_tokens`,
  `output_tokens`, `calls`, `cost_usd`) or a `tokens used: … cost: $…` line. `flora usage [run-id]` prints
  the invoice per step with retries and branches included; `--all` gives one line per run; the viewer shows
  the same table on the run page.
- **Graph, gates, triggers** — `needs`/`when` for a step graph, `parallel` branches with a quorum, `flora watch`
  for cron and event sources, `flora gate` as a pre-push hook, `flora mcp` for agents that author contracts.

## Model APIs — opt-in, per step

The agents are the local harnesses. When one step of a pipeline is pure judgement — classify, extract,
score — and you want it on a model API instead, name a provider in that step:

```yaml
- id: judge
  executor: { harness: api, provider: openrouter, model: anthropic/claude-sonnet-4.5, temperature: 0 }
  prompt: "Rate this post: {{steps.fetch.output.text}}"
  output: { type: json, schema: { type: object, required: [verdict] } }
```

and configure the provider once, on the machine, in `~/.flora/providers.yaml` — never in the pipeline:

```yaml
openrouter:
  base_url: https://openrouter.ai/api/v1
  api_key_env: OPENROUTER_API_KEY     # the key stays in the environment
  cost_in_usage: true                 # OpenRouter prices each call; flora records it
local:
  base_url: http://127.0.0.1:11434/v1 # Ollama, LM Studio, vLLM — anything OpenAI-compatible
  api_key_env: none
```

`flora doctor` lists the configured providers and whether their keys are set. No providers file, no API:
a step that names one gets a sentence on what to set up, and the run fails before anything is spent.

## Analytics: what went in, what came out, what it cost

Every run records its data flow (`needs` and `{{steps.<id>…}}` references), the size of every step's output,
the numbers a step reports about itself (`"metrics": {"in": 100, "out": 80}` in its JSON output) and the usage.
`flora analytics` lays them side by side per step; `--all --csv` gives one row per step per run for a
spreadsheet; the report and the viewer show the same with a flow graph. How to enable it in your own
workflow: [docs/analytics.ru.md](docs/analytics.ru.md) (in Russian).

```
step       from            in → out    took   calls       tokens       cost     output
filter        ingest         100 → 80  12m03s     3    1,200      $1.25    1.2 KB
```

## Two things flora keeps

- **The pipeline** — the workflow file (and its `.flora` bundle): steps, the graph, parameters, checks, output
  contracts, retries, and for every step where it runs — a local harness you are logged into (`claude-code`,
  `codex`, `antigravity`), a script (`command`), or a model API configured separately and named explicitly.
- **The artefact** — what one run went through: every step with the prompt as sent or the command as run,
  the checks and their verdicts, the contract output, the executor transcript, tokens and money, metrics and
  the data flow, retries, and the files a step declares as its artifacts (`"artifacts": ["calls.jsonl",
  "traces/02"]` in its output — the prompts it sent, the answers it got, its logs), copied into the run's
  artifact directory, linked from the viewer, listed in the report, carried by the export.

## Run history you can hold

The journal is a database; a run is also written as files. After every `flora run`, `~/.flora/runs/<run-id>/`
holds `run.json` (the record) and `report.md` (the run as a document: what ran, every step's checks, output
and executor output, what it cost) — `--report <file|dir>` puts a copy where you want it, and the viewer's
run page has a “Report ↓” link. To hand a run to someone:

```bash
flora report latest --out review.md        # the document alone
flora export latest                        # review-then-fix-11111111.flora-run: record + events + report
flora open review-then-fix-11111111.flora-run     # on their side: into the journal, the viewer up, the browser on it
```

A step that lists its files in its output — `"artifacts": ["cards", "results.jsonl"]` — travels with them:
they land in the run, in the export and in the viewer, where a markdown artifact reads in place. So a run
handed over as one file opens with the results themselves, not only the counts.

## Sharing a workflow

A workflow is rarely one file: it has scripts next to it, prompts, tool configs. `flora pack` turns the folder
it lives in into one `.flora` file (a zip anyone can look inside) with a manifest — name, description, params,
steps, the harnesses it needs, a checksum per file. Drop it in a chat; on the other side:

```bash
flora inspect nightly.flora                # what is in it, what it needs, before running anything
flora run nightly.flora --param source=…   # run straight from the file (unpacked into ~/.flora/bundles)
flora add nightly.flora                    # or install it: flora run nightly, flora workflows, flora remove nightly
```

No git, no registry, no shared drive. Inside a run the workflow finds its own files through `{{workflow_dir}}`
(`run: node "{{workflow_dir}}/stage.mjs"`), so it works wherever the folder or the bundle ends up. `pack` leaves
out `.git`, `node_modules`, `run/`, journals, logs, common credentials (`.env*`, `.npmrc`, `.netrc`, `.pypirc`, Git credentials, `*.key`, `*.pem`) and files over 8 MB; `--include` / `--exclude` adjust that. Explicit includes can override these defaults, so inspect the file list before sharing. A
bundle whose files no longer match their checksums is refused, and nothing is executed by unpacking — the
workflow's commands run only when you run it, like any other.

## Testing against real agents

`examples/e2e/` runs the whole thing against live models through OpenRouter — Claude Code, Codex and plain
chat models in `command` steps — covering contracts, tools, parallel branches, triggers and the authoring loop.
See `examples/e2e/README.md` for the environment; the set costs well under a dollar.

## Status

`v0.3.0` — one way to install (the npm package) and one kind of executor (a CLI on this machine): the standalone
installers and the hand-off of a step to a GUI agent through MCP are gone. The v0.2.1 hardening stays — see the
[audit and verification report](docs/audits/2026-09-05-quality-security.md). CI verifies tests, types and a tarball
install on macOS and Linux. Windows is not supported. Live model execution still requires a logged-in local harness. Known gaps:
`llm-judge` and `human` check types. MIT.
