# Open a saved run with its declared results

A portable run must contain every result file that its workflow declares. The
receiving machine should be able to inspect the run without the producing folder.

`flora open` imports a portable run when necessary, starts the local viewer and
opens the result. An existing run can be opened by identifier. `--no-browser`
supports terminals without a graphical session.

The producing workflow declares its result files explicitly. Flora does not guess
which files in a working directory belong in a portable export. Markdown results
open in the viewer through its text-based renderer; raw downloads remain available.

Validation covers portable import/export, declared files, browser launch arguments,
and Markdown headings, tables, lists, links and escaping. Repository examples and
fixtures use synthetic records and must not include private workflow materials.
