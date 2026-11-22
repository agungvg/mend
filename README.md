# mend — one patch tool for every AI edit format

`mend` applies an edit an AI model wrote to a tree of text files. Models write edits in four
formats, and `mend` reads all of them, per one written spec (`SPEC.md`):

- **unified diff** — often with wrong line numbers; mend finds the intended lines anyway
- **SEARCH/REPLACE blocks**
- **V4A patches** (`*** Begin Patch` … `*** End Patch`)
- **JSON tool calls** — an array, or one edit object per line

Matching is three-tiered: exact, then trailing whitespace ignored, then leading and
trailing whitespace ignored (with re-indentation of new lines). `--strict` matches exactly.
Every file changes or nothing does: if any edit fails, no file is written.

## Run

Node 22, standard library only — nothing to install.

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is a patch file, or `-` / absent for standard input. `--format` is `unified`,
`search-replace`, `v4a`, `json`, or `auto` (the default, detected from the patch).
`--check` reports what would change without writing anything.

## Exit codes and output

- `0` — one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move),
  then `ok: <n> files`
- `1` — one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`
- `2` — one line: `error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`

## Files

- `main.ts` — the whole tool
- `runner.ts` — the trial runner the kit uses (kept as shipped)
- `SPEC.md` — the specification this tool implements, version 1

## Verification

- 100/100 on the kit's practice checks (practice score 1000)
- 120 hand-written adversarial checks, one per spec sentence the practice set does
  not cover (nearest-occurrence and offset rules, `\ No newline at end of file`,
  CRLF and no-final-break files, tier-2 re-indentation, V4A cursor and end-of-file
  chunks, move output, atomicity), all passing

License: MIT. Built for the make.fun bounty "Build mend, one patch tool for every AI
edit format".
