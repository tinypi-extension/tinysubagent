# Todo: settings TUI for `tinysubagent.jsonc`

Implements `docs/specs/spec-settings-tui.md` per `docs/tasks/spec-project-config/plan.md`. Baseline at `8e7f784`:
typecheck clean, `npm test` → 247 pass / 0 fail.

- [x] **S1 — target selection.** `settingsTargets(cwd, agentDir, env?)` returns candidates
  highest precedence first (`override` → `project` → `root`) with `{ scope, file, exists }`;
  `defaultTarget(...)` returns the first that exists and otherwise the root file with
  `exists: false`. Both reuse the existing candidate table and `CONFIG_DIR_NAME`.
  Tests: project listed before root with honest `exists`; project beats an existing root;
  fallback to `<agentDir>/tinysubagent.jsonc` when nothing exists; `PI_TINYSUBAGENT_CONFIG`
  yields a single `override` target.
  - Files: `src/config/config.ts`, `test/config/config.test.ts`
- [x] **S2 — document layer.** `src/config/draft.ts`: `ConfigDraft { file, text }`,
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
- [x] **S3 — screen + registration.** `src/pi/settings-tui.ts`: `Container` with header
  (target path, scope, `exists`/`will be created`, layering hint), a `SettingsList`
  (`maxVisible: 12`) holding `Scope`, `Enable profiles`, one row per profile
  (`id: "profile:<name>"`, submenu with a model `Input`, a nested thinking `SettingsList`,
  `Rename`, `Delete`), `+ Add profile…`, then status and hint lines. Rebuild on
  structural change, `updateValue` otherwise, `selectItem` on the new row after add.
  `y/n` confirm before writing a file that does not exist. `done()` on every exit path.
  `index.ts` registers `/subagent-settings`, guarded by `ctx.hasUI && ctx.mode === "tui"`.
  Non-TUI mode: one `notify`, no screen, exit 0.
  - Files: `src/pi/settings-tui.ts`, `index.ts`
- [x] **S4 — docs.** `docs/intent.md` config section gains `/subagent-settings` and the
  no-hot-reload consequence (reload pi after an edit).
  - Files: `docs/intent.md`
- [ ] **S5 — checkpoint + manual verification + commit.** `npm run typecheck` clean;
  `npm test` all pass / 0 fail. Manual session: open `/subagent-settings`, flip
  `enableProfiles`, add/rename/delete a profile, Esc, reload, `git diff` the target file —
  only intended lines changed, comments intact. Result recorded here.
  - Files: `tasks/plan.md`, `tasks/todo.md`

## Implementation notes (S5)

Checkpoints, all with `npm run typecheck` clean:

| | Tests | Notes |
|---|---|---|
| CP0 (baseline `a1adfdb`) | 247 pass / 0 fail | |
| CP1 (S1–S2) | 262 pass / 0 fail | +13 document-layer cases, +5 target cases |
| CP2 (S3–S4) | 262 pass / 0 fail | screen added; suite unchanged, as planned |
| CP3 (S5) | **268 pass / 0 fail** | +4 command-wiring cases, +1 shape-refusal case, +1 targets case |

Deviations from the plan, all deliberate and reviewed:

1. **`/subagent-settings` is registered above the herdr guard** (`index.ts`), so the command
   exists in any pi session — editing a config file needs no pane. The tool below the guard is
   unchanged. Revert this if the command should be herdr-only.
2. **`pi.registerCommand?.()`** is called optionally: `test/pi/extension.test.ts`'s stub has no
   `registerCommand`, and a host without command support must still get the tool.
3. **The Scope row offers both scopes even when only one file exists**, naming the file a missing
   scope *would* be created as (`CONFIG_DIR_NAME` + `JSONC_CONFIG_FILENAME`, not a path of its
   own). `settingsTargets` lists only files that exist, so this is the screen's, not resolution's,
   invention — switching still never writes.
4. **Delete is a `no → yes` row cycle**, not an instant delete: with no Save step there is nothing
   to back out of an accidental keypress, and a refused delete reverts to `no`.
5. **A review turned up one blocker, now fixed**: a file that parses but cannot hold an edit (array
   root, `profiles` as a string/array, a profile as a number) made `jsonc-parser`'s `modify()`
   throw out of a keypress. `draftError` now reports `invalid-shape` for those, `applyModify`
   catches as a last resort, and `addProfile`'s refusal no longer assumes `draftError` is
   non-`undefined`. Also fixed: the Scope row and header now stop saying "will be created" once
   the file exists, and the post-add `selectItem`+Enter only fires for a row that is present.

Automated coverage now includes what used to be hand-only: the command registers under
`subagent-settings` outside herdr, non-TUI mode notifies once and opens no screen, opening writes
nothing, `y`/`n` behaviour on a missing file (including the exact bytes written), Esc reaching
`done()`, and the shape refusal above (`test/pi/settings-command.test.ts`).

**Manual session — still to do, by hand, in a real terminal** (the one thing no test here can
stand in for; it is the spec's own verification step and is *not* ticked above):

- [ ] `/subagent-settings` opens on the file resolution reads; flip `enableProfiles`, add a
      profile, rename it, add a model, cycle Thinking, delete it, Esc, reload pi.
- [ ] `git diff` the target file: only the intended lines changed, every comment still there.
- [ ] After the reload `resolveProfile` sees the new value.
- [ ] Layout, colours, submenu rendering and the hardware cursor in the model `Input` on a real
      terminal (unverifiable headlessly).

Committed on request before the manual pass (the spec gated the commit on it); the
checklist above is still open, and a fix that follows from it is a follow-up commit.
