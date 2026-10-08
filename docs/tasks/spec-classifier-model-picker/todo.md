# Todo: model picker for the `classifierModel` settings row

Spec: `docs/specs/spec-classifier-model-picker.md`. Plan: `plan.md`.

## Decisions (confirmed by the user)

- [x] **D3 — arbitrary values.** **D3a**: picker + a trailing `Type a value…` row opening today's text
      submenu, so unlisted/hand-written references stay enterable.
- [x] **D2 — the `(none)` clear entry.** Confirmed; it is the only way to unset
      `classifierModel` once the text input is gone.
- [x] **Commit shape.** Its own commit, on top of the uncommitted `spec-classifier-model` work.

## Capabilities (each TDD: failing test first)

- [x] **C1 — `classifierChoices` (`src/config/models.ts`).**
  - Add optional `getModelsOfType?(type: "classifier"): readonly RegistryModel[]` to
    `ModelRegistryLike`.
  - Add `classifierChoices(registry): ModelChoice[]`: same mapping, sort (label then value) and
    de-duplication as `modelChoices`, reading `getModelsOfType("classifier")`.
  - Degrade to `[]` when the method is absent, the registry is absent, or the call throws.
  - Tests (`test/config/models.test.ts`): maps classifier models to single-column rows with
    `label = value = "<provider-id>/<model-id>"` and no `description`; sorted and de-duplicated;
    `[]` when `getModelsOfType` is absent; `[]` when there is no registry; a malformed entry
    (`""` provider or id) is skipped; a throwing `getModelsOfType` yields `[]`.
- [x] **C2 — `setClassifierModel` removal (`src/config/draft.ts`).**
  - Widen to `value: string | undefined`; `undefined` removes the key (same as `setModel`).
  - Tests (`test/config/draft.test.ts`): setting a string writes it; `undefined` removes the key so
    `draftClassifierModel` is `undefined`; the existing "every mutator refuses on unparseable /
    invalid shape" list still holds.
- [x] **C3 — picker reuse (`src/pi/settings-tui.ts`).**
  - `ModelPicker` options: `title: string`, `empty: { label: string; description: string }`;
    remove the hard-coded `Model for "${name}"` and `(inherit)` / `this session's model` strings.
  - `ProfileSubmenu` passes `title: \`Model for "${this.name}"\`` and the old empty strings —
    profile rendering must stay byte-identical.
  - `RootStringRow` gains optional `pickerTitle?: string`; when set, that row's `submenu` opens the
    picker with `host.classifierChoices()` and the `PICKER_HINT` hint line, instead of
    `NameSubmenu`.
  - `ScreenHost` gains `classifierChoices(): readonly ModelChoice[]`; `SettingsScreen` snapshots it
    in the constructor beside `this.models`.
  - The classifier row sets `pickerTitle: "Classifier model"`; its empty entry is
    `(none)` / `no classifier; the systemOne* keys apply`, mapped to `setClassifierModel(draft, undefined)`.
  - If D3a: append a `Type a value…` row that opens the existing `NameSubmenu`.
- [x] **C4 — behavior tests (`test/pi/settings-command.test.ts`).**
  - `fakeRegistry()` gains `getModelsOfType`; add a classifier-model list to the fake.
  - Rewrite the classifier row tests to drive the picker (DOWN ×n, ENTER) instead of typing.
  - New: selection writes `"classifierModel": "<provider>/<model-id>"` to the file for the current
    scope and the row's displayed value updates.
  - New: a stored off-list value renders as `not in the model list` and survives an Esc.
  - New: the `(none)` entry removes the key from the file.
  - New: a registry without `getModelsOfType` (and a bare context) renders the empty state, no crash.
  - New (if D3a): `Type a value…` opens the text submenu and saves a typed value.
  - Regression: the profile model picker tests pass untouched.
- [x] **C5 — docs + verification.**
  - `README.md`: the `classifierModel` section says the settings row is a picker over the
    registry's classifier models, and that `(none)` clears the key.
  - `docs/specs/spec-classifier-model.md`: the settings paragraph no longer says the value is typed
    by hand.
  - `npm run typecheck` clean; `npm test` all pass / 0 fail.
  - Scope guard: `git diff --stat` shows no change to `src/systemone/*`, `src/pi/tool.ts`,
    `index.ts`, `src/present/describe.ts`, `src/children/*`.
  - Hand verify in a terminal: open the row, see the list, pick one, confirm the file; pick
    `(none)`, confirm the key is gone; confirm the profile Model row is unchanged.

## Implementation notes

**Final counts.** Baseline 393 pass / 0 fail. After: `npm test` **405 pass / 0 fail**
(+12: 4 in `test/config/models.test.ts`, 1 in `test/config/draft.test.ts`, 7 in
`test/pi/settings-command.test.ts` — six new picker tests plus the rewritten override-scope test,
less the one typed-entry test they replaced). `npm run typecheck` clean throughout. Every stage was
TDD: the seven picker tests were written first and failed against the old text-field row, then
passed after C3; the two review fixes added two more tests that also failed first.

**Deviations from the plan, and why.**

1. `RootStringRow.picker` is a **nested object** (`{ title, empty, clear, writeIn? }`) instead of the
   plan's flat `pickerTitle?: string`. Follows from strict contravariance: `RootStringRow.set` is
   typed `(draft, value: string) => ConfigDraft` for the three SystemOne rows, which only ever
   write, so the classifier row's key removal cannot route through `set` and needs its own `clear`.
   Keeping `title`/`empty`/`clear`/`writeIn` in one object that is absent on every other row keeps
   the four picker-only fields from widening the shared row shape.
2. **No `ScreenHost.classifierChoices()`.** The picker's `submenu` is built by `SettingsScreen`
   itself, so a host method would have no caller; the screen keeps a `classifiers` snapshot beside
   `this.models` instead.
3. `ModelPicker` reports `""` for the empty entry and `undefined` for a cancel (Esc). The plan's
   single `INHERIT` sentinel could not distinguish "cleared" from "cancelled" once a row other than
   the profile's had to clear a key. `ProfileSubmenu` maps `""` back to `(inherit)` for `setModel`,
   so its `done` contract and rendering are unchanged.
4. Extra rows the plan did not name: `Type a value…` **swap-and-restore** (the field replaces the
   list inside the same picker via `Container.clear()`, Esc closes the picker as the list's Esc
   does); a stored **blank** write-in submit is a no-op rather than a clear.
5. Review follow-ups, all landed: the screen's key line is restored in the submenu's close callback
   rather than at pick time, so a create-confirm (`y/n`) keeps the picker's own hint on screen; and
   the write-in row is matched by **item identity**, not by its sentinel value, so a stored
   reference that happened to equal the sentinel cannot open the field.

**Hand verification.** A scripted pass drove the real command handler, the real component tree and
real `SelectList`/`SettingsList` instances, in a temp config file, printing the rendered frames:

1. `Classifier model` row focused — empty value; Enter opens the list.
2. The list is titled `Classifier model`: `(none)` first (`no classifier; the systemOne* keys
   apply`), then the one-column rows `oc-openai/glm-5.3-flash` and `typesafe/jev-latest`, then
   `Type a value…`; the hint line reads `↑↓ walk models · Enter saves · Esc closes`. Neither chat
   model (`deepseek-flash`, `shared-id`) appears.
3. Arrows walk the list; Enter on `jev-latest` writes `"classifierModel": "typesafe/jev-latest"` to
   the file and the row shows `typesafe/jev-latest`.
4. `(none)` removes the key from the file and the row goes empty.
5. The profile submenu and its `Model for "fast"` picker are byte-for-byte unchanged: `(inherit)`
   first with `this session's model`, then the chat models.

The scripted pass is equivalent to the unit tests minus a human eye; no interactive `pi` session was
opened from here, so a real-terminal read-through is still worth doing once and is not claimed here.
