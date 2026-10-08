# Plan: model picker for the `classifierModel` settings row

Implements `docs/specs/spec-classifier-model-picker.md`. Baseline: the working tree carries the
implemented-but-uncommitted classifier feature; `npm run typecheck` clean, `npm test` = 393 pass /
0 fail.

## Approach

Four small, ordered edits, each TDD-first, then docs and one verification pass. Ordered so the
pure modules (`models.ts`, `draft.ts`) are done and tested before the screen consumes them; the
screen is one file with one existing pattern to copy.

## Capabilities

- **C1 — `classifierChoices` (`src/config/models.ts`).** Widen `ModelRegistryLike` with an optional
  `getModelsOfType?(type: "classifier"): readonly RegistryModel[]`; add
  `classifierChoices(registry): ModelChoice[]` reusing the existing mapping/sort/dedup. Pure, so it
  is unit-tested without a terminal. Tests in `test/config/models.test.ts`.
- **C2 — `setClassifierModel` removal (`src/config/draft.ts`).** Widen the signature to
  `value: string | undefined` so `undefined` removes the key (mirrors `setModel`). Tests in
  `test/config/draft.test.ts`.
- **C3 — picker reuse (`src/pi/settings-tui.ts`).** Parameterize `ModelPicker` with `title` and
  `empty`; add `RootStringRow.pickerTitle`; add `ScreenHost.classifierChoices` and the snapshot in
  the constructor; branch the classifier row's `submenu` to the picker. `ProfileSubmenu` passes the
  old title/empty strings so profile rendering is byte-identical.
- **C4 — behavior tests (`test/pi/settings-command.test.ts`).** Replace the classifier row's typed
  entry with picker driving; add: selection writes the file, off-list value is preserved and
  labelled, the empty entry removes the key, a registry without `getModelsOfType` renders the
  empty state, and the profile rows are unaffected.
- **C5 — docs + verification.** README note that the row is a picker (`(none)` clears it);
  `docs/specs/spec-classifier-model.md` settings paragraph updated from "typed by hand"; typecheck,
  full suite, `git diff` scope guard, and a recorded hand-verification result.

## Checkpoints

| Checkpoint | After | Gate |
| --- | --- | --- |
| CP1 | C1–C2 | `node --test test/config/models.test.ts test/config/draft.test.ts` green; typecheck clean |
| CP2 | C3 | typecheck clean; the existing settings suite green (profile rows unchanged) |
| CP3 | C4 | `node --test test/pi/settings-command.test.ts` green |
| CP4 | C5 | `npm run typecheck` clean; `npm test` all pass / 0 fail; diff scope guard holds |
| CP5 | hand verification | the row is driven in a real terminal; result recorded in `todo.md`; one commit |

## Risks

- **Breaking the profile picker.** Mitigated by parameterizing `ModelPicker` rather than cloning it,
  and by keeping the profile call site's title/empty strings byte-identical; the existing profile
  picker tests are the regression net.
- **Classifier row tests are rewritten.** They currently type a string; they must be rewritten to
  drive the picker. Their file assertions (the written JSON) stay as-is, so the contract under test
  does not weaken.
- **Registry shape drift.** Everything classifier-specific is reached through a structural optional
  method, so a registry without it degrades to the existing empty-list rendering rather than
  throwing.

## Boundaries

- Files: `src/config/models.ts`, `src/config/draft.ts`, `src/pi/settings-tui.ts`,
  `test/config/models.test.ts`, `test/config/draft.test.ts`, `test/pi/settings-command.test.ts`,
  `README.md`, `docs/specs/spec-classifier-model.md`, plus this task's docs.
- No new dependency; no change to routing/config resolution; `src/systemone/*`, `src/pi/tool.ts`,
  `index.ts`, `src/present/describe.ts` and `src/children/*` must show no diff.
