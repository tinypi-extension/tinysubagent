# Spec: settings TUI for `tinysubagent.jsonc`

**Status: approved.** Intent confirmed via `interview-me` (2026-08): root scope = `~/.pi/agent/`,
project wins when it exists, schema-aware editor (not a raw JSONC text box), comments preserved.
**Amended 2026-08 (after the screen shipped):** the profile submenu's model field is a
registry-backed picker — see "Model picker" and `Resolved decisions` 4.
Three follow-up questions were answered by the user on approval: command name
`/subagent-settings`; adding a profile inserts `{}` and opens its submenu; creating a file that
does not exist requires an explicit confirm. See "Resolved decisions".

## Assumptions I'm making

1. **"Root" means the agent dir** — `~/.pi/agent/tinysubagent.jsonc` (confirmed by the user).
   "Project" means `<cwd>/.pi/tinysubagent.jsonc|.json` exactly as `docs/spec-project-config.md`
   defines it, reusing `CONFIG_DIR_NAME` from the SDK rather than hardcoding `.pi`.
2. **The TUI edits one file per session** — the one config resolution picked. Default target:
   project file if one exists, otherwise the root file (created on the first edit, not on open,
   and only after the user confirms the creation).
3. **Editable surface is the two things `config.ts` knows about**: `enableProfiles` and
   `profiles.<name>.{model,thinking}`. No free-form key editing, no agents/roles, no `.pi/settings.json`.
   The `model` *value* may come from `ctx.modelRegistry`, but the surface is still only these keys.
4. **Comment preservation is a hard requirement.** The user's root file carries a commented-out
   line today; a rewrite that drops it is a regression, not a cosmetic difference.
5. **No hot reload.** Config is resolved once at registration (`index.ts:196`) and baked into the
   tool schema/description. The TUI writes the file and tells the user to reload pi.
6. **`cwd` comes from the command context** (`ctx.cwd`), not the registration-time
   `process.cwd()` — the command fires inside a session that may have navigated.
7. **Command name `/subagent-settings`.** `settings` is taken by pi's built-in and is matched
   first; picking it would silently never fire.
8. **`SettingsList` is the right component** — it is what pi's own `/settings` uses, so the
   interaction (Enter cycles values, Esc closes) is already muscle memory. `SettingsListTheme`
   must be reimplemented; `getSettingsListTheme` is internal to pi.
9. **No extension-facing settings store exists**, so this extension reads and writes the file
   itself with `node:fs`. There is no `settingsManager` on `ExtensionContext` to delegate to.
10. **Unknown keys pass through.** A path-scoped `jsonc-parser` edit never sees them, so a key
    this TUI does not model survives untouched — that is the desired behaviour, not a gap.

→ Correct any of these now, or I'll build on them.

## Current behaviour (verified, not assumed)

- **Resolution** (`src/config/config.ts:27-111`), highest precedence first:
  `$PI_TINYSUBAGENT_CONFIG` (the only file read) → `<cwd>/.pi/tinysubagent.jsonc` →
  `<cwd>/.pi/tinysubagent.json` → `<agentDir>/tinysubagent.jsonc` → `<agentDir>/tinysubagent.json`.
  Scope beats filename; `.jsonc` beats `.json` within a directory.
- **Files layer, they do not replace.** `enableProfiles` from the highest file that *specifies*
  it (`=== true` only); `profiles` merged by name. A new project file therefore does **not** blank
  the root file's profiles — the TUI must say so rather than let it look like a fresh start.
- **File shape** (`src/types.ts:54`): `{ enableProfiles?: boolean, profiles?: Record<string,
  { model?: string, thinking?: ThinkingLevel }> }`. `ThinkingLevel` =
  `off|minimal|low|medium|high|xhigh|max` (`src/types.ts:11-24`, `isThinkingLevel`).
- **`"current"` is reserved** (`src/config/config.ts:49,207`): a config that redefines it is
  rejected with a warning; `resolveProfile` treats it as "inherit parent model+thinking"
  (`src/config/profiles.ts:87`). The TUI must refuse add/rename to that name.
- **Config is resolved once**, at `index.ts:196`, and does not reach children
  (`docs/spec-project-config.md`, "Deliberate non-behaviour" §3).
- **Nothing is registered today** except the tool (`pi.registerTool`) and lifecycle hooks; there
  is no extension command. `pi-tui` is already a real import (`src/pi/tool.ts:20` imports `Text`).
- **Extension API available and verified** against installed `0.85.1`:
  - `pi.registerCommand(name, { description?, handler: (args, ctx) => Promise<void> })`
    (`dist/core/extensions/types.d.ts:891,946`; runtime `loader.js:246`). Name is literal, invoked
    as `/name`.
  - `ctx.ui.custom<T>(factory: (tui, theme, keybindings, done) => Component & {dispose?}, options?)`
    (`types.d.ts:116-128`). With no `overlay` option it replaces the editor and restores it when
    `done(value)` is called — if `done` is never called the promise never settles.
  - `SettingsList(items, maxVisible, theme, onChange(id,newValue), onCancel, { enableSearch })`;
    `SettingItem = { id, label, description?, currentValue, values?, submenu?(currentValue, done) }`
    (`pi-tui/dist/components/settings-list.d.ts`). `updateValue(id, v)`, `selectItem(id)` exist for
    non-structural updates; items are otherwise fixed at construction.
  - Also exported from `pi-tui`: `Container`, `Box`, `Text`, `Spacer`, `Input` (with
    `onSubmit`/`onEscape`, `pi-tui/dist/components/input.d.ts`), `SelectList`, `truncateToWidth`.
    **`DynamicBorder` is *not* exported** — the screen draws its own rule or uses `Box`.
  - `ctx.ui.notify`, `ctx.ui.input/select/confirm` exist but are modal dialogs; using them from
    inside a `ui.custom` component is not attempted by this spec (see "Deliberate non-behaviour").
- **`jsonc-parser` edit mechanics** (probed against the installed copy, not assumed):
  - `modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })` returns
    `Edit[]` and must be wrapped in `applyEdits(text, edits)`.
  - Change value: preserves comments elsewhere. Add key: inserts correctly but **re-expands an
    inline sibling object to multiline** — an accepted, one-time cosmetic change.
  - Delete: `modify(text, ["profiles", name], undefined, fmt)` removes the property, comments intact.
  - Rename: no API. Raw edit on the key node — `findNodeAtLocation(tree, ["profiles", name])`
    returns the **value** node; the key node is `node.parent.children[0]`.

## Objective

Profiles are the extension's main knob and today there is exactly one way to change them: hand-editing
a `.jsonc` file whose path differs by scope. Add a settings TUI so the user can change
`enableProfiles` and the `profiles` map from inside pi, against the file that config resolution
actually reads, without touching comments or losing a hand-maintained file to a rewrite.

Success is: open `/subagent-settings`, change a model, Esc, reload — and the file on disk differs
only in that value, with every comment still there.

## Scope check

One capability: editing this config file through a screen. Not decomposed — the acceptance criteria
all cluster around one file and one write path, and no part ships or is verified independently.

Internally it splits into two modules with different testability, which is a design decision, not a
capability map:

| Module | Responsibility | Tested |
|---|---|---|
| `src/config/draft.ts` | text-in/text-out edits over a `.jsonc` document; pure, no TUI, no fs except the write | unit, `node:test` |
| `src/pi/settings-tui.ts` | the screen: item list, submenus, key handling, write calls | by hand in a session |

The split exists so the interesting logic (comment-preserving edits, validation, target selection)
is testable without a terminal.

## Target selection (authoritative)

```ts
export type SettingsScope = "override" | "project" | "root";

export interface SettingsTarget {
	scope: SettingsScope;
	file: string;   // absolute
	exists: boolean;
}

/** Candidate targets, highest precedence first. */
export function settingsTargets(
	cwd: string,
	agentDir: string,
	env?: NodeJS.ProcessEnv,
): SettingsTarget[];

/** The target the screen opens on: the first that exists, else the root file (created on first edit). */
export function defaultTarget(
	cwd: string,
	agentDir: string,
	env?: NodeJS.ProcessEnv,
): SettingsTarget;
```

| Condition | Target |
|---|---|
| `$PI_TINYSUBAGENT_CONFIG` set | that file, scope `override`, whether or not it exists — it is the only file resolution reads |
| project `.jsonc` or `.json` exists | that file (`.jsonc` wins), scope `project` |
| neither exists | `<agentDir>/tinysubagent.jsonc`, scope `root`, `exists: false` |

The screen shows a **Scope** row whose values are the two (or one) targets, each labelled with its
path and `exists`/`will be created`. Switching it re-reads the chosen file and rebuilds the item
list. Switching never writes by itself.

Creating a project file while a root file exists is the layering case, so the header carries the
hint: *project layers over root — profiles merge by name*. That is the whole point of showing it:
otherwise creating an empty project file looks like it wiped the root profiles.

## Document layer (`src/config/draft.ts`)

The file's text is the source of truth; every operation is `text → text`.

```ts
export interface ConfigDraft {
	file: string;
	text: string;   // raw file text; "" when the file does not exist
}

export type DraftError =
	| { kind: "reserved-name"; name: string }
	| { kind: "duplicate-name"; name: string }
	| { kind: "empty-name" }
	| { kind: "invalid-thinking"; value: string }
	| { kind: "unparseable"; file: string; detail: string };

export type DraftResult = { ok: true; draft: ConfigDraft } | { ok: false; error: DraftError };

export function readDraft(file: string): ConfigDraft;
export function draftEnableProfiles(draft: ConfigDraft): boolean;
export function draftProfiles(draft: ConfigDraft): string[];        // sorted, "current" excluded
export function draftProfile(draft: ConfigDraft, name: string): { model?: string; thinking?: ThinkingLevel };

export function setEnableProfiles(draft: ConfigDraft, value: boolean): ConfigDraft;
export function setModel(draft: ConfigDraft, name: string, model: string | undefined): ConfigDraft;
export function setThinking(draft: ConfigDraft, name: string, thinking: ThinkingLevel | undefined): ConfigDraft;
export function addProfile(draft: ConfigDraft, name: string): DraftResult;
export function renameProfile(draft: ConfigDraft, from: string, to: string): DraftResult;
export function deleteProfile(draft: ConfigDraft, name: string): ConfigDraft;

export function writeDraft(draft: ConfigDraft): void;   // mkdir -p dir, write tmp + rename, trailing \n
```

Rules:

- **Never `JSON.stringify`.** Not for the whole file, not for one profile. Every mutation is a
  `jsonc-parser` `modify()` (plus the raw key edit for rename) so comments, key order, and unknown
  keys survive. This is the reason the layer exists.
- `model: undefined` / `thinking: undefined` **removes** the key rather than writing `null` — an
  absent key means "inherit this session's model/thinking", which is `Profile`'s semantics.
- An empty `profiles` object is left in place on delete; removing the last profile does not remove
  `profiles`.
- Validation lives here, not in the UI: `addProfile`/`renameProfile` reject `current`, a duplicate,
  and an empty/whitespace name; `setThinking` is typed, so an invalid level cannot get in.
- `writeDraft` is atomic (tmp + `renameSync`) and creates the parent directory. A new file is
  always created as `.jsonc` — the dialect that allows comments, and the one resolution prefers.
- A target file that exists but does not parse is **not** silently replaced: `readDraft` keeps its
  text, and the screen refuses to write (see "Failure behaviour").

Because items are fixed at construction, add/rename/delete **rebuild** the `SettingsList`; value
changes call `updateValue(id, v)` instead.

## Screen (`src/pi/settings-tui.ts`)

Opened by `/subagent-settings`; `index.ts` registers it (that file is wiring only, which is exactly
where a registration belongs).

```
pi.registerCommand("subagent-settings", {
	description: "Edit tinysubagent profiles (enableProfiles + profiles.<name>)",
	handler: async (_args, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("tinysubagent: settings need interactive mode.", "warning");
			return;
		}
		await ctx.ui.custom((tui, theme, _keybindings, done) =>
			createSettingsScreen({ ctx, theme, done }),
		);
	},
});
```

Layout (`Container`), top to bottom:

1. **Header** — `tinysubagent settings` + the target path + scope + `exists`/`will be created`,
   then the layering hint when both scopes exist.
2. **SettingsList**, `maxVisible: 12`, rows rebuilt after any structural change:
   - `Scope` — values `["project", "root"]` (one row, cycling; single value when the override is set).
   - `Enable profiles` — values `["false", "true"]`.
   - one row per profile, `id: "profile:<name>"`, `currentValue` showing `model` and `thinking`
     (`—` when absent), `description` naming the file it lives in:
     - `submenu` → a second small `Container`: the model `Input` (a filter — see "Model picker"),
       a `SelectList` of the models the registry can run under it, and a nested `SettingsList` for
       `Thinking` (values `["(inherit)", ...THINKING_LEVELS]`), `Rename`, `Delete`.
   - `+ Add profile…` — an inline `Input` for the name, validated by `addProfile`. On success the
     profile is inserted as `{}` — both fields absent, exactly like `current`'s inherit-both
     semantics — the list rebuilds, the cursor lands on the new profile's row (`selectItem`), and
     its submenu opens so a model can be picked immediately.
3. **Status line** — the last validation error or write error, dim; empty otherwise.
4. **Hint line** — `Enter cycle · Esc close · changes write immediately · reload pi to apply`.

### Model picker

The model field is a picker over the models `ctx.modelRegistry.getAvailable()` can actually run,
built by `src/config/models.ts` — pure, so *what* it shows and *what* an Enter writes are tested
without a terminal.

- Rows are `(inherit)` first, then every available model: `label` = the bare id, `description` =
  the model's name and provider label. `value` is `provider/id` — the canonical string the config
  holds and the one handed to `pi --model` (`src/children/launch-script.ts:123`) — and it is what
  the list filters on, so what the user types is what the file gets.
- The `Input` is the filter, not the value. It is deliberately **not** seeded with the current
  model: a seeded field would filter the list down to that one row before the user typed anything.
  The line above it names the current model (`(inherit)` when the key is absent).
- ↑/↓ walk the list, Enter saves the highlighted row and moves the cursor to the rows (where the
  old field left it), Tab switches between field and rows, Esc closes the submenu.
- **Free text survives.** When the typed text matches no row, Enter resolves it against the
  registry: an exact `provider/id`, a bare id, or a unique fragment becomes the canonical
  `provider/id`; a string naming nothing is written as typed — the field was free text before the
  picker existed, and the registry is not the whole world (providers not logged in, models pi has
  not fetched). The line under the field says what will be written, so the fallback is never silent.
- **Ambiguity is refused, not guessed.** Text naming several models (e.g. `flash` with two
  providers logged in) writes nothing and says so on the status line — the same refusal pi's own
  resolver makes for ambiguous bare ids (`dist/core/model-resolver.d.ts`).
- Empty stays empty: `(inherit)` and an empty field both remove the `model` key, which downstream
  reads as "inherit this session's model".
- **No registry, no picker.** A session that never configured a provider — or any caller passing a
  bare context — yields no rows: the list is not rendered and the field behaves exactly as it did
  before the picker existed.
- **The screen still never touches the session's model.** Picking a row writes a profile's `model`
  key; `ctx.setModel` is not called anywhere.

### Confirm before creating a file

A write whose target does not exist creates it, and that can mean writing into the user's home
directory (`~/.pi/agent/tinysubagent.jsonc`). The first mutating action against a non-existent
target therefore does not write: the screen enters a one-shot confirm state, the footer becomes
`Create <path>? y/n`, and the component's `handleInput` intercepts the answer.

- `y` proceeds with the pending change — write, clear the confirm state, rebuild.
- `n` or Esc discards the pending change only; the screen stays open on the same target.
- Any other key is ignored, so a stray arrow key cannot create a file.

This is deliberately *not* `ctx.ui.confirm`: that is a modal dialog over the editor, and a
component created by `ui.custom` already owns the editor (see "Deliberate non-behaviour"). The
confirm state is one boolean plus the pending edit, held by the screen.

Commit timing: **every change writes immediately**, matching pi's own `/settings`. Consequence: no
dirty state, no lost work on Esc, and no Save/Cancel rows. The cost is a disk write per keystroke-
adjacent action, which is fine for a file this size and is the answer to "did it save?".

Interaction with the host: `done()` must always run, including on Esc (`onCancel`), or
`ctx.ui.custom` never resolves and the editor stays replaced. The component owns `dispose()` for
the rebuild.

## Failure behaviour

- **Reserved name** — add/rename to `current` is rejected with the same reason `config.ts:207`
  gives: it is a built-in profile and cannot be redefined. Shown on the status line; the file is
  untouched.
- **Duplicate / empty name** — status line, file untouched.
- **Unparseable target** — the screen opens read-only: rows render, any change is refused with
  "…is not valid JSONC (…); not writing". No repair, no overwrite.
- **Write failure** (read-only dir, `EACCES`) — the change is rolled back in memory (previous text
  restored), status line names the file and the error. The screen stays open.
- **Non-TUI mode** (`--print`, RPC without UI) — one `notify`, no screen, exit 0.
- A missing target file is **never** an error and is not created on open — only on the first edit,
  and only after the confirm above. Declining the confirm is not an error either: the status line
  is cleared and the change is dropped.

## Deliberate non-behaviour

- **No whole-file rewrite**, ever. See "Document layer".
- **No hot reload.** Config is registration-time (`index.ts:196`); the hint line says to reload.
  Re-resolving per call is excluded by `docs/intent.md:64`.
- **No effective/merged view.** The screen shows the file it edits, not the layered result. A merged
  view would raise "which file does this edit land in?" and this design's answer is always "the one
  in the header".
- **No `.pi/settings.json` integration** — `src/config/config.ts:1` is explicit that this config
  does not entangle with pi's settings file.
- **No `ctx.ui.input/select/confirm` from inside the custom component.** They are modal dialogs over
  the editor; nesting them under a component that already owns the editor is untested. Free-text
  input uses the pi-tui `Input` component inside the component instead.
- **No `<cwd>/.pi` creation** unless the user actually edits project scope.
- **No agent/role editing** — markdown roles have their own mechanism (`src/config/agents.ts`).

## Files

| File | Change |
|---|---|
| `src/config/draft.ts` | **new** — document layer: `readDraft`/`draft*`/`set*`/`addProfile`/`renameProfile`/`deleteProfile`/`writeDraft`, `DraftError` |
| `src/config/models.ts` | **new** — the picker's rows and the typed-text rule: `modelChoices(registry)`, `resolveTypedModel(choices, typed)`, structural `ModelRegistryLike` |
| `src/config/config.ts` | **new exports** — `settingsTargets(cwd, agentDir, env)` + `defaultTarget(...)`, reusing the existing candidate table and `CONFIG_DIR_NAME` so the screen cannot drift from resolution |
| `src/pi/settings-tui.ts` | **new** — `createSettingsScreen({ ctx, theme, done })`, `SettingsListTheme` implementation, submenu container, status/hint lines |
| `index.ts` | `pi.registerCommand("subagent-settings", …)` — the file's header already declares it wiring-only |
| `test/config/draft.test.ts` | **new** — unit tests for the document layer |
| `test/config/config.test.ts` | cases for `settingsTargets` / `defaultTarget` |
| `test/config/models.test.ts` | **new** — unit tests for the picker's rows and the typed-text rule |
| `docs/intent.md` | config section: mention `/subagent-settings` and the no-hot-reload consequence |

No new dependencies: `jsonc-parser` is already a runtime dependency and `pi-tui` a peer — the
picker is that package's own `SelectList`, the same component pi's `/model` selector is built from.

## Commands

```
Test:      npm test            # node --test "test/**/*.test.ts"
Typecheck: npm run typecheck   # tsc --noEmit
Smoke:     npm run smoke
```

`npm test` and `npm run typecheck` must both be clean. The screen's wiring and key handling are
driven through `test/pi/settings-command.test.ts` — a fake `ctx.ui.custom` and a fake registry, no
terminal; what it *looks* like in a real terminal is still verified by hand in a herdr session.

## Code style

Pure text-in/text-out functions with explicit arguments; comments explain why a rule exists:

```ts
export function setThinking(
	draft: ConfigDraft,
	name: string,
	thinking: ThinkingLevel | undefined,
): ConfigDraft {
	// Absent means "inherit this session's level", so an unset is a key removal —
	// writing null would parse as a value and lose the inheritance.
	const edits = modify(draft.text, ["profiles", name, "thinking"], thinking, FORMAT);
	return { ...draft, text: applyEdits(draft.text, edits) };
}
```

Errors are values (`DraftError`), not exceptions, because every one of them is a status line the
user stays in the screen to read. Warnings/notifications stay one sentence and name the file.

## Testing strategy

`node:test` + `node:assert/strict`, temp dirs via `mkdtempSync` — extending
`test/config/config.test.ts`'s harness (`writeNamed`, `configDir`). No test touches the real
`~/.pi`; `agentDir` is always an argument. `PI_TINYSUBAGENT_CONFIG` is set only inside a
`withEnv`-guarded test (pattern already in `test/pi/extension.test.ts:55-71`).

New cases, one per rule:

1. `settingsTargets` lists project before root; `exists` reflects the filesystem.
2. `defaultTarget` picks an existing project file over an existing root file.
3. `defaultTarget` falls back to `<agentDir>/tinysubagent.jsonc` with `exists: false` when nothing exists.
4. `PI_TINYSUBAGENT_CONFIG` yields a single `override` target, existing or not.
5. `setModel` / `setThinking` change one value and preserve a comment elsewhere in the file.
6. `setThinking(name, undefined)` removes the key rather than writing `null`.
6b. `addProfile` inserts `{}` for a valid new name — no `model`/`thinking` keys in the resulting text.
7. `addProfile` inserts a key on a file that has none (empty text ⇒ new object).
8. `addProfile("current")` → `reserved-name`; `addProfile("")` → `empty-name`; duplicate → `duplicate-name`.
9. `renameProfile` rewrites the key and leaves the value and comments intact.
10. `deleteProfile` removes the property, keeps `profiles`, keeps sibling comments.
11. `writeDraft` creates the parent directory and writes atomically; a second write is idempotent.
12. An unparseable file is reported by `readDraft`'s consumer path and no write is attempted
    (`DraftError.unparseable` surfaced, text unchanged).
13. A profile whose object carries an unknown extra field keeps that field through an unrelated edit.
14. `modelChoices` maps a registry snapshot to rows: `value` is `provider/id`, the provider display
    name is used, a nameless model falls back to the provider id, duplicates and malformed entries
    are dropped, and no registry (or an empty one) yields no rows.
15. `resolveTypedModel`: `""` → inherit; a canonical value and a bare id → the canonical value; a
    unique fragment → that model; several matches → `ambiguous`; an unknown string → itself.
16. `test/pi/settings-command.test.ts` drives the submenu with a fake registry: the list offers the
    registry's models, Enter writes the highlighted one, a bare fragment resolves through the
    registry, unknown text is written as typed, ambiguous text writes nothing, an untouched
    submenu writes nothing, and without a registry the field is the plain one.

Verification of the screen is manual and recorded, not faked: open `/subagent-settings` in a herdr
session, flip `enableProfiles`, add a profile, rename it, delete it, Esc, reload — then `git diff`
(or `cat`) the target file and confirm only the intended lines changed.

## Boundaries

- **Always:** run `npm test` and `npm run typecheck`; preserve comments and unknown keys; keep
  resolution and draft helpers pure and argument-driven; write atomically; name the file in any
  error; call `done()` on every exit path including Esc.
- **Ask first:** renaming the command; adding a dependency; adding a merged/effective view; editing
  keys outside `enableProfiles`/`profiles`; re-resolving config after write (hot reload); changing
  the picker's agreed shape (`Resolved decisions` 4) — a session-model row, registry validation of
  hand-typed ids, or refreshing the registry while the screen is open.
- **Never:** `JSON.stringify` the config; write a file the user did not select; create `~/.pi` or
  `<cwd>/.pi` as a side effect of opening; overwrite an unparseable file; register the command as
  `settings`; let a validation error leave the file half-written.

## Out of scope

- Editing agents/roles (markdown) or anything outside profiles.
- Hot reload / re-resolving config after a write.
- Migrating an existing `.json` file to `.jsonc`.
- Switching the *session's* model — the picker writes a profile's `model` key; `ctx.setModel` is
  not called.
- Validating a hand-typed model beyond the ambiguity refusal: a string the registry does not know
  is written as typed, exactly as it was before the picker existed.
- Multiple-scope editing in one screen (one file per session).
- Mouse support beyond what `SettingsList` already implements.

## Success criteria

1. `/subagent-settings` opens on the file config resolution reads: project when one exists,
   `<agentDir>/tinysubagent.jsonc` otherwise.
2. Changing `enableProfiles` writes only that key; every other line, including comments, is byte-identical.
3. Adding, renaming, and deleting a profile work against a dynamic key set, and the item list
   reflects the change immediately.
4. `current` cannot be added or renamed to; a duplicate or empty name is refused with a visible reason.
5. Nothing is written when the screen is only opened. A missing target is created on the first
   edit and only after a `y` confirm; `n` leaves the filesystem untouched.
6. An unparseable target is never overwritten.
7. A write error leaves the previous text in place and is reported on the status line.
8. Esc always closes and restores the editor (no hung `ui.custom`).
9. `npm test` passes, including every pre-existing test; `npm run typecheck` is clean.
10. Manual session check: after the edit and a reload, `resolveProfile` sees the new value, and
    `git diff` on the target file shows only the intended lines.
11. In non-TUI mode the command notifies once and exits without a screen or an error.
12. The model field offers the registry's available models with `(inherit)` first and the profile's
    own model highlighted; ↑/↓ walk it and Enter writes the highlighted `provider/id`.
13. Typed text naming one model writes its canonical `provider/id`; text naming none is written as
    typed; text naming several writes nothing and says so.
14. A session with no available models gets the free-text field, not an empty picker.
15. Nothing above is weakened by the picker: the write path, the create confirm, rollback, comment
    preservation, and the rows are untouched.

## Resolved decisions

Answered by the user on approval (2026-08) — not open questions:

1. **Command name** — `/subagent-settings`. `settings` is rejected because pi's built-in is matched
   first, and `subagent-profiles` was considered but the screen also owns `enableProfiles`.
2. **Add-profile shape** — insert `{}` and open the new profile's submenu. No model prompt first:
   absent fields already mean "inherit", so the two-step version is pure extra friction.
3. **Creating a file requires a confirm** — see "Confirm before creating a file". Editing an
   existing file never asks.
4. **Model editing is a registry picker** (2026-08, after the screen shipped) — the user asked for
   option (a): replace the free-text `model` field with a list of the models the registry can run,
   not a second screen and not a session-model switch. Consequences accepted with it: `(inherit)`
   as the first row, free text kept as the fallback when nothing matches, free text written
   verbatim unless the registry resolves it (bare id or unique fragment → `provider/id`), and
   ambiguous text refused rather than guessed. The picker lives in `src/config/models.ts` so the
   rules are tested without a terminal.
