# End-to-end on real agents

Seven contracts that exercise flora against live models — through OpenRouter, so
one key covers Claude Code, Codex and any chat model in a plain `command` step.
Run them after changing the engine, an adapter, tools, watch or parallel.
The whole set costs well under a dollar.

| contract | what it proves |
|---|---|
| `01-contracts.yaml` | output contracts with a schema, `{{steps.*}}` data flow between two different models, a check built from step 1's output |
| `02-claude-code.yaml` | Claude Code headless: touches the file system, honours a JSON contract, the verifier reads the file |
| `03-codex.yaml` | Codex headless (`codex exec --json`), usage from `turn.completed`, JSON contract |
| `04-tools.yaml` | tools per node: Claude Code calls `read_context` and `call_workflow` on the mounted `flora mcp`; a plain step checks the answers |
| `05-parallel.yaml` | three agents on one task in separate worktrees, quorum, patches, a collector |
| `06-watch.yaml` | a polled source emits an event, the triggered step uses `{{event.*}}` |
| `07-authoring.yaml` | Claude Code fixes a broken workflow with `validate_workflow` until it is green |

## Environment

Run `flora doctor` first: it tells you which harness is installed, logged in, or choking on its own config.

```bash
export OPENROUTER_API_KEY=sk-or-…                      # every command step and Codex read it

# Claude Code through OpenRouter (Anthropic-compatible endpoint)
export ANTHROPIC_BASE_URL=https://openrouter.ai/api
export ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY
export ANTHROPIC_MODEL=anthropic/claude-haiku-4.5      # sonnet-4.5 for the tool-heavy 04 and 07
export ANTHROPIC_DEFAULT_HAIKU_MODEL=anthropic/claude-haiku-4.5
export ANTHROPIC_SMALL_FAST_MODEL=anthropic/claude-haiku-4.5
unset ANTHROPIC_API_KEY CLAUDECODE                     # a logged-in claude, or one nested in Claude Code, would get in the way

# Codex through OpenRouter, with a private config so yours stays untouched
export CODEX_HOME=$PWD/examples/e2e/codex-home

export FLORA_DB=/tmp/flora-e2e.db                      # keep the e2e runs out of your real journal
```

## Running

```bash
S=$PWD/examples/e2e/or-chat.mjs
flora run examples/e2e/01-contracts.yaml --cwd /tmp/e2e/01 --param script=$S
flora run examples/e2e/02-claude-code.yaml --cwd /tmp/e2e/02
flora run examples/e2e/03-codex.yaml --cwd /tmp/e2e/03
cp examples/e2e/review-verdict.yaml /tmp/e2e/04/ && flora run examples/e2e/04-tools.yaml --cwd /tmp/e2e/04
git -C /tmp/e2e/05 init && git -C /tmp/e2e/05 commit --allow-empty -m init && flora run examples/e2e/05-parallel.yaml --cwd /tmp/e2e/05 --param script=$S
flora watch examples/e2e/06-watch.yaml --once --cwd /tmp/e2e/06 --param script=$S
flora run examples/e2e/07-authoring.yaml --cwd /tmp/e2e/07 --param flora_bin=$PWD/bin/flora.mjs
flora serve   # then look at the runs
```

## What to expect

- `05-parallel`: a branch may fail on purpose — on the last run Codex declared it could not write files and
  answered anyway; the verifier failed that branch and the quorum of two carried the step. That is the point.
- `07-authoring`: the agent's YAML is re-run by flora as the check; it may use tools your machine lacks (`jq`).
- Claude Code's `costUsd` is its own estimate from its price table — through a proxy it is not your bill;
  the token counts are real. Prompt caching does not survive the OpenRouter hop, so a Claude Code turn is
  ~90k input tokens each time.
- Model ids move: `openai/gpt-4o-mini`, `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-4.5` and
  `google/gemini-2.5-flash` existed when this was written. `wire_api` for Codex must be `responses`.
