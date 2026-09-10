# Make saved results readable to an analyst

The real run inspection exposed a usability gap: long records made single table rows fill the viewport, the shell command consumed a third of the step view, and one failed request was difficult to find. The user clarified that the reader is an analyst, while Flora remains a general workflow tool.

This bounded change keeps the localhost viewer read-only, following issues #2 and #3. It adds a readable Record view, compact table rows, a direct failed-request filter, concise saved error messages with original details retained, and English/Russian reading guides. Script commands, execution parameters and statistics remain available under disclosure controls. Agent prompts still appear next to their inputs and outputs. A passed step with failed earlier attempts is described differently from a failed step.

The guide explicitly distinguishes a workflow `.flora` from a result `.flora-run`. Reading a result does not run a model. Starting a new workflow still requires the CLI and the author's launch instructions; this change does not invent a start button or add execution endpoints.

Validation: 348 unit/integration tests and TypeScript passed. Real Chrome checks cover records, compact rows, call failure/retry navigation, Russian help, files, Markdown, HTML-as-text, keyboard/focus and narrow/dark layouts. Live output and final result restoration were checked; output targets the executor transcript instead of accidentally overwriting a saved command. The npm tarball was separately installed and reports 0.5.1. Screenshots use only synthetic fixtures; user workflows, the actual failed run and its dataset remain outside Git.
