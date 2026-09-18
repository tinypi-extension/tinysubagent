# Todo: settings TUI for `tinysubagent.jsonc`

Implements `docs/specs/spec-settings-tui.md` per `docs/tasks/spec-project-config/plan.md`. Baseline at `8e7f784`:
typecheck clean, `npm test` → 247 pass / 0 fail.

- [ ] **S1 — target selection.** `settingsTargets(cwd, agentDir, env?)` returns candidates
  highest precedence first (`override` → `project` → `root`) with `{ scope, file, exists }`;
  `defaultTarget(...)` returns the first that exists and otherwise the root file with
  `exists: false`. Both reuse the existing candidate table and `CONFIG_DIR_NAME`.
  Tests: project listed before root with honest `exists`; project beats an existing root;
  fallback to `<agentDir>/tinysubagent.jsonc` when nothing exists; `PI_TINYSUBAGENT_CONFIG`
  yields a single `override` target.
  - Files: `src/config/config.ts`, `test/config/config.test.ts`
- [ ] **S2 — document layer.** `src/config/draft.ts`: `ConfigDraft { file, text }`,
  `DraftError` union, `readDraft`, `draftEnableProfiles`, `draftProfiles`, `draftProfile`,
  `setEnableProfiles`, `setModel`, `setThinking`, `addProfile`, `renameProfile`,
  `deleteProfile`, `writeDraft`. Every mutation is a `jsonc-parser` `modify()` (rename =
  raw edit on `findNodeAtLocation(...).parent.children[0]`); `undefined` removes a key;
  validation returns errors as values; `writeDraft` mkdirs and writes tmp + rename.
  Tests: value change preserves a comment elsewhere; unset removes the key; add on empty
  text creates the object; `current`/empty/duplicate refused; rename keeps value +
  comments; delete keeps `profiles` and sibling comments; write creates the dir and is
  idempotent; unparseable file surfaces `unparseable` and writes nothing; an unknown extra
  field in a profile survives an unrelated edit.
  - Files: `src/config/draft.ts`, `test/config/draft.test.ts`
- [ ] **S3 — screen + registration.** `src/pi/settings-tui.ts`: `Container` with header
  (target path, scope, `exists`/`will be created`, layering hint), a `SettingsList`
  (`maxVisible: 12`) holding `Scope`, `Enable profiles`, one row per profile
  (`id: "profile:<name>"`, submenu with a model `Input`, a nested thinking `SettingsList`,
  `Rename`, `Delete`), `+ Add profile…`, then status and hint lines. Rebuild on
  structural change, `updateValue` otherwise, `selectItem` on the new row after add.
  `y/n` confirm before writing a file that does not exist. `done()` on every exit path.
  `index.ts` registers `/subagent-settings`, guarded by `ctx.hasUI && ctx.mode === "tui"`.
  Non-TUI mode: one `notify`, no screen, exit 0.
  - Files: `src/pi/settings-tui.ts`, `index.ts`
- [ ] **S4 — docs.** `docs/intent.md` config section gains `/subagent-settings` and the
  no-hot-reload consequence (reload pi after an edit).
  - Files: `docs/intent.md`
- [ ] **S5 — checkpoint + manual verification + commit.** `npm run typecheck` clean;
  `npm test` all pass / 0 fail. Manual session: open `/subagent-settings`, flip
  `enableProfiles`, add/rename/delete a profile, Esc, reload, `git diff` the target file —
  only intended lines changed, comments intact. Result recorded here.
  - Files: `tasks/plan.md`, `tasks/todo.md`
