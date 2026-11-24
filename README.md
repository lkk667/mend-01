# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lkk667/mend-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lkk667/mend-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

AI models write edits in four shapes, and each shape gets its details
wrong in its own way: unified diffs carry stale line numbers, SEARCH/REPLACE
blocks drift in whitespace and indentation, V4A patches anchor on lines
that moved, and JSON tool calls misspell a key. `mend` reads any of the
four, finds the lines each edit really names, and writes every change or
none at all.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or `-` (or nothing) to read the patch from
standard input. The working directory is the root of the tree the patch
applies to. `--format` picks one format (`unified`, `search-replace`,
`v4a`, `json`); `auto`, the default, detects it. `--check` does
everything but write. `--strict` matches lines exactly, with no
whitespace forgiveness.

## What it does

- **Unified diffs** — sections from `diff --git` or `---`/`+++` pairs,
  creations, deletions and renames, hunks applied in order against the
  lines the patch actually names (the nearest occurrence to the hunk's
  line number, however wrong it is), and the file's final line break
  kept or dropped the way the `\ No newline at end of file` marker says.
- **SEARCH/REPLACE blocks** — the path from the line above the block
  (fences and prose ignored), a block that names lines twice is
  `ambiguous`, an empty old block creates the file.
- **V4A patches** — add, delete and update sections, `*** Move to:`
  renames, chunks found by anchor with a cursor that only moves forward,
  and `*** End of File` chunks pinned to the file's last line.
- **JSON edits** — one array or one object per line: `create`,
  `str_replace` (exact, overlapping positions counted) and `insert`,
  with CRLF files read and written back in CRLF.
- **Matching** — three tiers: exact, then trailing whitespace ignored,
  then leading and trailing whitespace ignored with added lines
  re-indented to the file's own indent.
- **All or nothing** — edits run in order on the tree as earlier edits
  left it; a failed edit changes nothing and the ones after it still
  run, so every failure is reported; when any edit failed, no file is
  written.

`main.ts` is the whole tool: Node 22 and its standard library alone.
`runner.ts` is the kit's trial runner, kept as it is. The full contract
is `SPEC.md` in the kit.

See the entry at [make.fun/bounty/hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
