# Installing flora

flora is an npm package: `@absolutemode/flora`, binary `flora`. There is one way to install it and it is
the same on Windows, macOS and Linux.

## What you need

- **Node 22.5 or newer.** The run journal is `node:sqlite`, a built-in that arrived in 22.5. On an older Node
  `flora` prints the version it found and stops before anything else happens. Get a current Node from
  [nodejs.org](https://nodejs.org); Node 22 and 24 are what CI runs.
- **npm** comes with Node. Git is not required to install flora — a particular workflow may need it.
- **The harnesses a workflow uses**, installed and logged in on the same machine: `claude` for `claude-code`
  steps, `codex` for `codex` steps. `command` steps need nothing; `api` steps need a provider configured in
  `~/.flora/providers.yaml`. flora never installs or logs into a harness for you.

## Install

From the npm registry, once the package is published there:

```bash
npm install -g @absolutemode/flora
```

From a release file — the same package, for a machine without registry access: download `absolutemode-flora-<version>.tgz` and `SHA256SUMS.txt` from the
[release](https://github.com/AbsoluteMode/flora-public/releases/latest), check the sum, then

```bash
npm install -g ./absolutemode-flora-<version>.tgz
```

From a checkout, for working on flora itself: `npm ci`, then either `npm run flora -- <args>` in place of
`flora <args>`, or `npm install -g .` to put that checkout on the PATH. `flora doctor` says out loud when it
runs from a checkout, because a checkout runs whatever its working tree currently holds.

## Check

```bash
flora --version
flora doctor       # version, where flora runs from, every harness it found and what to fix
```

`flora doctor` calls no model; it looks for the harness binaries, asks each whether it is logged in, and
checks the journal path and any configured API providers.

## Open a run someone sent you

A run travels as one `.flora-run` file: the record, every step's checks and output, the files the steps
declared, the report. One command puts it in your journal, starts the viewer and opens your browser on it:

```bash
flora open example-run.flora-run
```

Leave the terminal open while you read; ctrl-c stops the viewer. The run stays in the journal — `flora open`
with the same file later just opens it (`--force` replaces it), and `flora open <run-id>` or plain
`flora open` bring the viewer back on a run or on the list. Markdown files a step kept — a card, a report —
open in place; anything else opens as a raw file.

## Update and remove

Install again with the new version — npm replaces the old one — or `npm update -g @absolutemode/flora` when it
came from the registry. To remove: `npm uninstall -g @absolutemode/flora`. Neither touches `~/.flora`, where
the run journal, installed workflows and provider configuration live; delete that directory yourself if you
want a clean slate.

## Let an agent author workflows

An agent that will run your workflows can also write them against the real contract, through flora's MCP
server. `flora connect` prints the settings with the absolute paths of the installed runtime and entrypoint:

```bash
flora connect --client codex            # TOML for ~/.codex/config.toml
flora connect --client claude-code      # JSON for `claude mcp add-json` or an .mcp.json
flora connect --client claude-desktop   # JSON for Claude Desktop's local MCP settings
flora connect --client generic          # JSON: command + args for any stdio MCP client
```

The output is configuration, not a command to execute: add the `flora` entry to the client's MCP settings,
keeping the entries already there, and restart the client. flora never edits an application's settings.

## Releasing (maintainers)

Bump `version` in `package.json`, commit, tag `v<version>` and push the tag. The release workflow runs the
full CI matrix, packs the tarball, attaches it and `SHA256SUMS.txt` to a GitHub release, and publishes the
same tarball to npm when `NPM_TOKEN` is configured — an absent token leaves the release with the file only.
