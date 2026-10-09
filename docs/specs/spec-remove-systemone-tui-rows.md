# Spec: Remove the three SystemOne rows from `/subagent-settings`

Status: approved. Intent confirmed by the user before this spec was written.

## Goal

The `/subagent-settings` screen shows three deprecated rows — `SystemOne API key`, `SystemOne base URL`,
`SystemOne model` — that edit config keys the product already tells people not to use. Remove them so
`classifierModel` is the only routing control on the screen.

The legacy keys keep working. This is a TUI surface change, not a deprecation-escalation change: a
`config.json` that still lists `systemOne*` must keep resolving and keep routing exactly as it does today.

## Confirmed intent

- **Outcome:** `/subagent-settings` renders no SystemOne rows; `classifierModel` is the only routing row.
- **Why now:** the keys were deprecated in favour of `classifierModel`, but the screen still presents them
  as first-class, equally-weighted controls.
- **Success:** the screen renders no SystemOne row; the rewritten assertions are green; `tsc --noEmit` clean.
- **Constraint:** the SystemOne transport, config resolution, and the one-time deprecation warning stay
  untouched, so existing config files do not change behaviour.
- **Out of scope:** deleting the SystemOne path; changing `classifierModel` behaviour or any other screen
  area; migrating or rewriting anyone's `config.json`.

## Decisions

- **D1 — Scope is the TUI surface only.** `src/systemone/*`, `SystemOneConfig`, `resolveSystemOne`,
  `SYSTEM_ONE_KEYS` and `warnSystemOneDeprecated` in `src/config/config.ts` all stay. The keys must still
  resolve from a file so hand-edited configs keep working.
- **D2 — Delete the now-dead draft accessors.** `draftSystemOneAPIKey`, `draftSystemOneBaseUrl`,
  `draftSystemOneModel`, `setSystemOneAPIKey`, `setSystemOneBaseUrl`, `setSystemOneModel` in
  `src/config/draft.ts` are imported only by `src/pi/settings-tui.ts` within `src/`, and `index.ts` does not
  re-export them. They go with the rows. `rootString()` (the shared helper) stays — `draftClassifierModel`
  uses it.
- **D3 — Reword the classifier row's empty entry.** `"no classifier; the systemOne* keys apply"` becomes
  `"no classifier configured"`. The row's other copy (`describe`, picker `title`) already names only
  `classifierModel` and does not change.
- **D4 — No README change.** README documents the `systemOne*` keys and the deprecated routing section, not
  the settings rows; every statement in it stays true after this change. The deprecated section is left in
  place because the keys still work.
- **D5 — Supersede the old row-order clause.** `docs/specs/spec-classifier-model.md` (§~283) and
  `docs/tasks/spec-classifier-model/todo.md` (§49) pin `classifierModel` as *preceding* the SystemOne rows.
  That clause is historical; this spec replaces it. Those files are not edited.

## Edit sites

Authoritative map, current working tree (`src/pi/settings-tui.ts`, 1137 lines).

### `src/pi/settings-tui.ts`

| What | Lines | Action |
|---|---|---|
| imports of the six draft accessors | 62–64, 70–72 | delete those six lines |
| imports of `DEFAULT_SYSTEMONE_BASE_URL`, `SYSTEMONE_MODEL` | 51–52 | delete — used only by the rows below |
| row-id constants `SYSTEMONE_KEY_ROW`, `SYSTEMONE_URL_ROW`, `SYSTEMONE_MODEL_ROW` | 91–93 | delete (each referenced exactly once, inside the array below) |
| `rootStringRows` array | 905–944 | keep the `classifierModel` entry (906–919); delete the three SystemOne entries (920–943) |
| classifier row's empty entry | 915 | reword `description` per D3 |
| `RootStringRow` doc comment ("the classifier and the three SystemOne keys") | 95–99 (mentions at 96) | reword to describe the array generically |

No other occurrence of `systemOne`/`SystemOne` exists in the file. The generic row machinery
(`rootStringRows` loop at 945–968, `setRootString`, `clearRootString`, `syncRow`, `onChange` at 1062–1084)
is driven by row objects and needs no change: `onChange` only branches on `SCOPE_ROW` and `ENABLE_ROW`.
There is no row-id union, key map, or group enum to update beyond the three constants.

### `src/config/draft.ts`

- Delete lines 218–243: the six accessors with their one-line docs.
- Keep lines 212–216 (`rootString`) and every classifier accessor. `draftClassifierModel` calls `rootString`.

### `test/pi/settings-command.test.ts`

Delete — assert only on the removed rows:

- helper comment + `focusSystemOneModel` (478–488), `openSystemOneModel` (496–500), `savedSystemOneModel` (502–505).
  `focusClassifierRow` (490–494) stays: item indices are unchanged, since the classifier row is already at
  index 2 above the removed rows.
- `the SystemOne model row names the default and writes the typed model` (506–533)
- `the SystemOne model row shows the stored model and Esc writes nothing` (535–554)
- `a SystemOne row shows the value it just wrote, not the one it opened with` (556–577)

Change:

- `the classifier row sits above the three SystemOne rows and names its shape` (579–602): drop the
  row-order block (584–593) and the now-wrong title; keep the `describe` assertion (594–600).
- `the classifier row opens the classifier list, not a text field` (621–…): line 631 asserts the reworded
  description — update to the D3 string.
- `the (none) entry removes the key so the SystemOne keys apply again` (742–763): the body is
  behaviour-only and still passes; refresh the title so it does not name a row that no longer exists.

### `test/config/draft.test.ts`

- Remove the imports of `draftSystemOneModel` (line 15) and `setSystemOneModel` (line 21).
- `an unparseable file surfaces unparseable and no edit or write changes it` (156–180): drop the
  `setSystemOneModel(...)` line in the mutator list (172), keep the test.
- Delete `setSystemOneModel writes the root key and preserves comments elsewhere` (205–219).
- `a document that parses but cannot hold an edit is refused, not thrown` (248–292): drop the
  `setSystemOneModel(...)` mutator line (272) and the `draftSystemOneModel(...)` assertion (290), keep the test.

### Kept unchanged

`test/config/config.test.ts` (routing, classifier, deprecation-warning tests), `test/pi/extension.test.ts`,
`test/pi/tool.test.ts`, `test/children/*`, `test/systemone/*`, `test/config/profiles.test.ts`, and all of
`src/systemone/*`, `src/config/config.ts`, `README.md`, `docs/`.

## Acceptance criteria

1. `render(80)` of the settings screen contains none of `SystemOne API key`, `SystemOne base URL`,
   `SystemOne model`; the classifier row is directly below `Enable profiles`.
2. The classifier row's `(none)` entry reads exactly `no classifier configured`.
3. No row id, constant, import, or comment in `src/pi/settings-tui.ts` mentions SystemOne.
4. `src/config/draft.ts` exports none of the six SystemOne accessors; `draftClassifierModel` and
   `setClassifierModel` behave as before.
5. A config file with `systemOneAPIKey`/`systemOneBaseUrl`/`systemOneModel` still resolves — those keys still
   route, and still emit the existing deprecation warning (covered by the untouched config tests).
6. Writing the classifier value from the screen still round-trips to the file, and Esc still writes nothing.

## Verification

```
npm run typecheck
node --test test/pi/settings-command.test.ts
node --test test/config/draft.test.ts
npm test           # baseline: 427 pass / 0 fail at d226d11
```

Final gate: `npm test` → 423 pass, 0 fail (427 minus the 4 tests this change deletes: the three SystemOne row
tests and the `setSystemOneModel` draft test), with 0 skipped. There is no linter in this repo.

## Risks

- Unused imports would not fail `tsc` (`noUnusedLocals` is off, and there is no lint), so removing
  `DEFAULT_SYSTEMONE_BASE_URL` / `SYSTEMONE_MODEL` from the imports is easy to forget — criterion 3 covers it.
- Row-index-sensitive tests move if the item order changes; `focusClassifierRow` keeps sending two DOWNs
  only while the classifier row stays at index 2. Assert the rendered order (criterion 1) rather than
  relying on index arithmetic alone.
