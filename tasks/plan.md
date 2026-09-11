# Plan: code layout refactor

Implements `docs/spec-code-layout.md`. Repo `tinysubagent` @ `87dd773`.

**Baseline (verified):** `npm run typecheck` clean; `npm test` → `1..241`, 241 pass, 0 fail;
Node v22.23.2; test glob is the non-recursive `node --test test/*.test.ts`.

**Goal:** `index.ts` becomes ≤120 lines of wiring; `src/` is organized by concern; no
observable behavior changes; the two latent `import.meta.url` path traps are eliminated and
the missing test that would have caught them is added.

## Components

| Component | Deliverable | Lines in → out |
|---|---|---|
| `paths-hardening` | `src/paths.ts` — single `findPackageRoot`-based resolver; `pluginDir()` and `childExtensionPath` sourced from it; new `test/paths.test.ts` | `herdr.ts` 384→~378, `spawn.ts` 355→~353, new files ~40 + ~50 |
| `deep-splits/launch` | `children/{launch-paths,launch-script,task-markdown}.ts` + `launch.ts` façade | 287 → 105 + 126 + 28 + 10 |
| `deep-splits/child` | `children/{report,settle,preflight}.ts` + trimmed `child.ts` | 422 → 80 + 60 + 95 + 160 |
| `deep-splits/spawn` | `children/{contract,requests}.ts` + trimmed `spawn.ts` | 355 → 62 + 88 + 197 |
| `src-reorg` | 14 src files into `config/ herdr/ children/ present/`; 14 tests into mirrored folders; quoted recursive test glob | moves only |
| `index-decompose` | `present/{describe,ack-render}.ts`, `pi/{capability,plugin-fix,lifecycle,watch-batch,tool}.ts`; `index.ts` → wiring | 559 → ≤120 |
| `docs-refresh` | path citations in `README.md` + `docs/spec-*.md`; layout section in `docs/intent.md` | prose |

## Dependency graph and order

```
paths-hardening ──> deep-splits/launch ──> deep-splits/child ──> deep-splits/spawn ──> src-reorg ──> index-decompose ──> docs-refresh
```

Strictly sequential. Every arrow is a real dependency, not a preference:

- `deep-splits` needs `paths-hardening` because `childExtensionPath` must already live in
  `paths.ts` before `spawn.ts` is split, otherwise the split has to carry a path constant that
  is about to move again.
- `src-reorg` needs `deep-splits` so the directory move is a **pure rename**; any breakage is
  then attributable to one change instead of two interacting ones.
- `index-decompose` needs `src-reorg` because it imports `spawn`/`herdr`/`present` modules by
  their final paths, and because `test/extension.test.ts` is only correctly homed in `test/pi/`
  after that file exists.
- `docs-refresh` needs the final tree to cite.

**Nothing here can be parallelized.** Within `deep-splits` the three files are independent of
each other but must land sequentially anyway, because each one must be verified green in
isolation before the next begins (ascending importers 1 → 4 → 6, descending test coverage).

Two independent streams do exist inside `src-reorg` — the `src/` move and the `test/` move —
but they must land in **one commit** because `package.json`'s test glob and the test import
paths break together. Splitting them leaves `npm test` matching zero files.

## Risks and mitigation

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `childExtensionPath` resolves to `<repo>/src/src/child.ts` after the move | High if done naively | **Silent.** Suite stays green, real child spawn hangs. pi loads no child extension → no `subagent_report` tool, no `agent_settled`, no input preflight. | Fix in `M1` before any move; assert the file exists on disk in `test/paths.test.ts`; `npm run smoke:tool` + `smoke:interrupt` as a mandatory gate on M1 and M3. |
| R2 | `pluginDir()` → `<repo>/src/herdr-plugin` after the move | High if done naively | `test/herdr/cli.test.ts` throws at import (its `pluginDir()` call is at module load), so **19 cases vanish** and the run reports a non-zero pass count. | Same resolver fix in M1. Never assert only on the pass count — also assert `globSync(...).length === 15`. |
| R3 | Unquoted `test/**/*.test.ts` is `sh`-expanded to `test/*/*.test.ts` | Certain if unquoted | Silently drops root-level `test/tool-patterns.test.ts` (10 cases). | Quote it in `package.json`. Verified: `sh -c 'echo test/**/*.test.ts'` passes the literal through only when quoted. |
| R4 | Hoisting `finished`/`lastMessages`/`runSignal` out of `tinysubagentChild`'s closure | Medium | Breaks "no overwrite after report" and leaks state across children in a long-lived process. | Explicit boundary in the spec; `test/child.test.ts:284-306` pins the overwrite behavior. |
| R5 | A split lets a second module compute a sidecar path | Medium | Watcher desyncs from the child; batch waits on timeout. | `buildLaunchPaths` stays the single source; `buildLaunchScript` receives path strings via options. Pinned by `test/launch.test.ts:46-64`. |
| R6 | New import cycle (`present/ack-render.ts` ↔ `pi/tool.ts` is the plausible one) | Low-Medium | Runtime `undefined` at module init; `verbatimModuleSyntax` won't catch it. | Graph is a DAG today; verify after M4 with a cycle check over `src/` and keep `ack-render.ts` free of `pi/` imports. |
| R7 | `MAX_PARALLEL_TASKS` lands in the wrong half of the `spawn.ts` split | Medium | Creates a `requests → spawn` back-edge, i.e. a cycle. | It is used in-file **only** by `collectRequests`; it moves to `requests.ts` per the spec. |
| R8 | `errorText`/`errorMessage` get "unified" while splitting | Low | Breaks the deliberate `child.ts`-must-not-import-spawn separation. | Named as a Boundary ("Never") in the spec. |
| R9 | Moving files by hand and inferring an import path from a filename | Medium | Wrong path, caught by typecheck — but a *wrong* path that happens to exist is worse. | Rewrite imports mechanically from the verified file:line lists in the recon reports in this session; never infer. |
| R10 | `deep-splits` leaves `spawn.ts` over 200 lines | Medium | Violates success criterion 5. | Measured budget: contract 62 + requests 88 → spawn ~197. Verify with `wc -l` before committing; fallback (higher risk, rewrites `spawnOne`'s body) is extracting the pane placement block. |

## Verification checkpoints

Every checkpoint runs from the repo root. **A checkpoint is not passed on a green exit code;
it is passed on the right numbers.**

| Checkpoint | After | Commands | Expected |
|---|---|---|---|
| CP0 | — (have it) | `npm run typecheck && npm test` | clean; `1..241`, 241 pass, 0 fail |
| CP1 | M1 | typecheck + test + `npm run smoke:tool` + `npm run smoke:interrupt` | clean; 241+N pass; both smokes spawn a real child and settle |
| CP2a | M2 launch | typecheck + test | clean; 241+N, 0 fail |
| CP2b | M2 child | typecheck + test | clean; 241+N, 0 fail |
| CP2c | M2 spawn | typecheck + test + `wc -l src/spawn.ts` | clean; 241+N, 0 fail; spawn ≤ 200 |
| CP3 | M3 | typecheck + test + file-count probe + both real-child smokes | clean; **241+N, 0 fail**; `globSync("test/**/*.test.ts").length === 15`; smokes pass |
| CP4 | M4 | typecheck + test + cycle check + `wc -l index.ts` + `smoke:tool` | clean; 241+N, 0 fail; DAG; `index.ts ≤ 120` |
| CP5 | M5 | everything | clean; all smokes |

Mandatory invariants at every checkpoint:

```bash
npm run typecheck
npm test 2>&1 | tail -8                       # compare to previous count exactly
node -e 'console.log(require("node:fs").globSync("test/**/*.test.ts").length)'   # must not drop
```

Failure signature to watch for at CP3: **222 passing with a file-level failure** means
`test/herdr/cli.test.ts` threw at import and its 19 cases were dropped. That is a failing
checkpoint even though the exit status looks like progress.

## Parallel work vs sequential

- **Sequential:** M1 → M2 → M3 → M4 → M5. No exceptions; each depends on the previous tree.
- **Independent inside a module:** the three `deep-splits` files, and the `src/`+`test/` moves
  inside M3. Independent *to write*, must still land as one verified step each.
- **Genuinely parallelizable:** none. Do not attempt to overlap M4 with M3 — `index-decompose`
  rewrites import lines that `src-reorg` is simultaneously rewriting.

## Rollback

Each module is one commit on top of a green checkpoint. Reverting any single commit returns the
repo to the previous green state, because no module leaves the tree in a state where
`npm test` matches zero files. The one commit that must never be partially applied is M3
(directory move + test glob + test relocations + the `-e` path tail).
