# Plan: settings TUI for `tinysubagent.jsonc`

Implements `docs/specs/spec-settings-tui.md` (approved). Repo `tinysubagent` @ `8e7f784`.

**Baseline (verified):** `npm run typecheck` clean; `npm test` → 247 pass / 0 fail.

**Goal:** `/subagent-settings` opens a screen over the config file resolution actually
reads — project (`.pi/tinysubagent.jsonc|.json`) when one exists, else
`<agentDir>/tinysubagent.jsonc` — and edits `enableProfiles` and the dynamic `profiles`
map (per-profile `model` + `thinking`), writing through `jsonc-parser` edits so comments,
key order, and unknown keys survive. Every change writes immediately; Esc closes.

## Decisions fixed by the spec

1. Two modules: `src/config/draft.ts` (pure text→text, unit-tested) and
   `src/pi/settings-tui.ts` (screen, hand-verified). Target helpers live in
   `src/config/config.ts` so the screen cannot drift from resolution.
2. Text is the source of truth. Never `JSON.stringify`; `undefined` **removes** a key
   (absent = inherit this session's model/thinking); writes are atomic (tmp + rename).
3. `"current"` is reserved (`config.ts:49,207`) — add/rename to it is refused. Dynamic
   keys mean add/rename/delete rebuild the `SettingsList`; value changes `updateValue`.
4. Writing to a file that does not exist requires an in-component `y/n` confirm
   (spec §"Confirm before creating a file"), never `ctx.ui.confirm`.
5. Add profile inserts `{}` and opens the new row's submenu (user answer).

## Modules

| Module | Deliverable |
|---|---|
| S1 | `src/config/config.ts`: `settingsTargets(cwd, agentDir, env?)` + `defaultTarget(...)` reusing the existing candidate table; `test/config/config.test.ts` cases 1–4 |
| S2 | `src/config/draft.ts` (new): `ConfigDraft`/`DraftError`/`readDraft`/`draft*`/`set*`/`addProfile`/`renameProfile`/`deleteProfile`/`writeDraft`; `test/config/draft.test.ts` cases 5–13 |
| S3 | `src/pi/settings-tui.ts` (new): `createSettingsScreen`, `SettingsListTheme`, submenu, status/hint lines, confirm state; `index.ts` registers `/subagent-settings` |
| S4 | Docs: `docs/intent.md` config section names `/subagent-settings` + the no-hot-reload consequence |
| S5 | Checkpoint: typecheck + full suite; commit |

## Checkpoints

| Checkpoint | After | Expected |
|---|---|---|
| CP0 | — (have it) | 247 pass / 0 fail; typecheck clean |
| CP1 | S1–S2 | typecheck clean; suite green with the 13 new document-layer/target cases |
| CP2 | S3 | typecheck clean; suite unchanged and green; screen verified by hand in a herdr session |
| CP3 | S4–S5 | typecheck clean; `npm test` all pass / 0 fail; one commit |

The screen has no automated test: `SettingsList` + `ctx.ui.custom` need a live terminal.
It is verified by hand (open, flip `enableProfiles`, add/rename/delete a profile, Esc,
reload, `git diff` the target file) and the result recorded in `tasks/todo.md`.

## Boundaries

- **Never:** `JSON.stringify` the config; write a file the user did not select; create
  `~/.pi` or `<cwd>/.pi` from merely opening the screen; overwrite an unparseable file;
  register the command as `settings` (the built-in matches first); leave `done()` uncalled.
- **Ask first:** renaming the command; a new dependency; an effective/merged view; editing
  keys outside `enableProfiles`/`profiles`; hot reload after write.
