# Plan: Remove the three SystemOne rows from `/subagent-settings`

Implements `docs/specs/spec-remove-systemone-tui-rows.md` (approved).

- **Repo:** `tinysubagent` @ `d226d11`
- **Baseline:** `npm run typecheck` clean; `npm test` → **427 pass / 0 fail / 0 skipped** (~8.2 s, `node --test "test/**/*.test.ts"`)
- **Working tree at plan time:** `README.md` modified (pre-existing, unrelated to this change — herdr requirement row, install snippet, troubleshooting rows) and the new spec file untracked. Neither is touched by this plan.
- **Runner:** `node:test`. There is no vitest and no linter.

## Goal

`/subagent-settings` stops offering the deprecated `systemOne*` keys. `classifierModel` becomes the only
routing row on the screen. The keys themselves keep resolving from `config.json`, keep routing, and keep
emitting the existing deprecation warning — this change is the TUI surface only.

## Decisions fixed by the spec

1. **D1** — TUI surface only. `src/systemone/*`, `SystemOneConfig`, `resolveSystemOne`, `SYSTEM_ONE_KEYS`,
   `warnSystemOneDeprecated` all stay.
2. **D2** — the six draft accessors in `src/config/draft.ts` are deleted with the rows; `rootString` stays
   (shared with `draftClassifierModel`).
3. **D3** — the classifier row's empty description becomes `no classifier configured`.
4. **D4** — no README change; the deprecated routing section stays because the keys still work.
5. **D5** — this spec supersedes the "classifier row precedes the SystemOne rows" clause in
   `docs/specs/spec-classifier-model.md`; that file is not edited.

## Capabilities

| Capability | What it delivers | Depends on |
|---|---|---|
| C1 — drop the rows | `src/pi/settings-tui.ts` has no SystemOne rows, constants, imports or comment; new empty-entry copy | — |
| C2 — settings tests | `test/pi/settings-command.test.ts` asserts the new row set and copy | C1 |
| C3 — dead accessors | the six accessors leave `src/config/draft.ts`; `test/config/draft.test.ts` follows | C1 |

Build order: C1 → C2 → C3. C2 and C3 are independent of each other.

## Expected intermediate state

Between C1 and C2/C3 the suite is deliberately red: three settings tests assert on rows that no longer
render, and one draft test imports an accessor that still exists. `npm run typecheck` stays clean
throughout (unused imports do not fail: `noUnusedLocals` is off). Only the final checkpoint requires a
green suite.

## Checkpoints

| Checkpoint | After | Verify |
|---|---|---|
| 1 | C1 | `npm run typecheck` clean; `grep -in systemone src/pi/settings-tui.ts` → no match; the settings screen still builds (targeted run shows only the three row tests failing) |
| 2 | C3 | `node --test test/config/draft.test.ts` → pass; `grep -rn "SystemOne" src/config/draft.ts` → the two classifier doc comments only |
| 3 | C2 + final | `npm run typecheck`; `node --test test/pi/settings-command.test.ts`; `npm test` → 423 pass / 0 fail (427 − 4 deleted tests); the rendered screen shows no SystemOne label |
