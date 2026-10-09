# Tasks: Remove the three SystemOne rows from `/subagent-settings`

Implements `docs/specs/spec-remove-systemone-tui-rows.md` (approved). Plan: `plan.md`.
Baseline: `npm test` → 427 pass / 0 fail at `d226d11`. The final checkpoint compares against that.

- [ ] **C1 — Drop the rows from the screen.** In `src/pi/settings-tui.ts`: delete the six draft-accessor imports (62–64, 70–72); delete the `DEFAULT_SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` imports (51–52) now that nothing else uses them; delete the three row-id constants (91–93); delete the three row objects from `rootStringRows` (920–943), keeping the `classifierModel` entry (906–919); reword the classifier `(none)` description at 915 to `no classifier configured`; reword the `RootStringRow` doc comment (95–99) so it no longer says "the three SystemOne keys". Leave the generic machinery (`rootStringRows` loop 945–968, `setRootString`, `clearRootString`, `syncRow`, `onChange` 1062–1084) alone — it is row-driven and branches only on `SCOPE_ROW` / `ENABLE_ROW`.
  - Acceptance: `grep -in systemone src/pi/settings-tui.ts` returns nothing; the classifier row is the row directly below `Enable profiles`; the empty picker entry reads exactly `no classifier configured`.
  - Verify: `npm run typecheck`; `node --test test/pi/settings-command.test.ts` (expected red: only the three row tests that C2 rewrites)
  - Files: `src/pi/settings-tui.ts`

- [ ] **C2 — Rewrite the settings tests.** In `test/pi/settings-command.test.ts`: delete the SystemOne helper comment and `focusSystemOneModel` (478–488), `openSystemOneModel` (496–500), `savedSystemOneModel` (502–505); keep `focusClassifierRow` (490–494), whose two DOWNs are still correct. Delete the three row tests (506–533, 535–554, 556–577). Rewrite `the classifier row sits above the three SystemOne rows and names its shape` (579–602) as a row-set test: assert the rendered screen contains none of the three SystemOne labels and that `Classifier model` renders after `Enable profiles`, keeping the `describe` regex assertion (594–600). Update the description assertion at 631 to the new copy. Refresh the title of the `(none)` test (742) so it does not name a removed row; its body is behaviour-only and stays.
  - Acceptance: the file contains no `SystemOne API key` / `SystemOne base URL` / `SystemOne model` label assertion and no dead helper; the reworded copy is asserted; the classifier round-trip and Esc tests still pass unchanged.
  - Verify: `node --test test/pi/settings-command.test.ts`
  - Files: `test/pi/settings-command.test.ts`

- [ ] **C3 — Delete the dead draft accessors.** In `src/config/draft.ts`: delete the six accessors and their one-line docs (218–243). Keep `rootString` (212–216) — `draftClassifierModel` uses it — and keep the classifier doc comments that mention the legacy keys. In `test/config/draft.test.ts`: drop the `draftSystemOneModel` (15) and `setSystemOneModel` (21) imports; drop the `setSystemOneModel` line in the unparseable-file mutator list (172); delete `setSystemOneModel writes the root key and preserves comments elsewhere` (205–219); drop the `setSystemOneModel` mutator line (272) and the `draftSystemOneModel` assertion (290) from the refused-edit test.
  - Acceptance: `src/config/draft.ts` exports no SystemOne accessor and `draftClassifierModel` / `setClassifierModel` are untouched; no test imports a deleted accessor.
  - Verify: `npm run typecheck`; `node --test test/config/draft.test.ts test/config/config.test.ts`
  - Files: `src/config/draft.ts`, `test/config/draft.test.ts`

- [ ] **C4 — Final check.** Confirm the SystemOne path still works end to end with the keys set from a file (untouched config tests are the evidence), and confirm the screen is clean at 80 columns.
  - Acceptance: `npm test` → 423 pass / 0 fail (427 − 4 deleted tests); `npm run typecheck` clean; `render(80)` contains no SystemOne label; `git diff --stat` shows only the four source/test files plus the two new doc files.
  - Verify: `npm run typecheck`; `npm test`; `git diff --stat`
  - Files: — (verification only)

## Outcome (all capabilities complete)

Final state verified on the working tree: `npm run typecheck` clean; `npm test` → **423 pass / 0 fail / 0
skipped** (~8.0 s), i.e. 427 minus the four deleted tests; `node --test test/pi/settings-command.test.ts` →
22 pass; `grep -in systemone src/pi/settings-tui.ts` → no match; `grep -rn
"SystemOneAPIKey\|SystemOneBaseUrl\|SystemOneModel" src/` → no match.

Diff: `src/pi/settings-tui.ts`, `src/config/draft.ts`, `test/pi/settings-command.test.ts`,
`test/config/draft.test.ts` — 4 files, 11 insertions / 188 deletions. `README.md` and `docs/` outside the two
new files untouched.

C1 and C2 ran in one worker as a red/green pair; the strict test-before-source order was not possible because
the parallel C3 worker had already dropped the draft accessors, so `src/pi/settings-tui.ts` failed at module
load until C1 landed. RED was captured post-C1 (20 pass / 5 fail, all five failures SystemOne-related), then
C2 took it to 22 pass / 0 fail. Net result matches the spec.
