# diff-speed

A fast line diff whose patch is byte-identical to makefun-diff 1.0.0's
patch for the same two texts — a faster drop-in for makefun-diff.

![makefun](https://make.fun/badge/diff-speed-01-run-20261126.svg)
![rank](https://make.fun/badge/diff-speed-01-run-20261126/ovokai/diff-speed-20261127/rank.svg)
![reward](https://make.fun/badge/diff-speed-01-run-20261126/ovokai/diff-speed-20261127/reward.svg)

Entry for the [diff-speed-01-run-20261126 bounty](https://make.fun/bounty/diff-speed-01-run-20261126)
("Diff two texts faster", $100 pool, 1st–10th $10 each).

## How it works

- Each text is indexed once: every line's start offset plus two
  independent 32-bit hashes of the line's code units (its trailing
  newline included), so comparing lines during the search is a pair of
  integer compares instead of a walk over the characters.
- The common prefix is kept, then the common suffix of what is left,
  and Myers's greedy search (furthest point per diagonal, deletion
  preferred on a tie, no diagonal pruned, every equal run followed to
  its end) runs on the middle only. The search records, for each depth,
  the furthest old-line count reached on each diagonal, in one flat
  integer table shared by all the depths and reused from case to case;
  the script is then walked back from the far corner.
- Every kept pair of the finished script is re-checked by direct
  comparison of the code units, and a failure re-runs the whole diff
  with exact comparisons, so a hash collision can never change the
  answer.
- The patch is built exactly as makefun-diff writes it: a header line,
  hunks of at most 3 kept lines of context, runs at most 6 kept lines
  apart sharing a hunk, deletions before insertions inside a run, and
  a `%` line after a line that ends its text with no newline.

## Layout

- `solve.js` — the diff. `run({ old, new })` returns the patch string.
  Dependency-free, standard library only.
- `main.ts` — the harness entrypoint. Reads `/input/cases.json`,
  answers each case with `run`, writes `/output/answers.json`.
  (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in for
  `/input` / `/output` outside a container.)

## Local check

With the kit unpacked, from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

On the practice set it passes 4 of 4 cases, and runs the set in about
0.6 s end to end on this machine, against about 1.6 s for the house
baseline (makefun-diff 1.0.0) measured beside it.

## License

MIT — see [LICENSE](LICENSE).
