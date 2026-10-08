# Spec: a model picker for the `classifierModel` settings row

Status: implemented. Builds on `spec-classifier-model.md` (which is implemented but not yet
committed in the working tree). Decisions confirmed by the user: **D3a** (picker plus a trailing
`Type a value…` row), **D2** yes (`(none)` clears the key), and this change lands as **its own
commit** on top of the uncommitted classifier work.

## Problem

On `/subagent-settings`, `classifierModel` is the only model-valued row that must be typed by
hand as `"<provider>/<model-id>"`. The profile **Model** row already opens a `ModelPicker`
(a pi-tui `SelectList`); the classifier row still opens a one-line `Input`.

Typing the reference is error-prone and undiscoverable: the user must know the provider id and
the exact model id, and a value that `findOfType("classifier", provider, modelId)` cannot resolve
does not fail at edit time — it fails later, per request, as
`tinysubagent: classifier model "<raw>" is not available; keeping "current".`

## Goal

Selecting the `Classifier model` row opens a picker over the models the registry can actually run
as classifiers, and selecting one writes `<provider>/<model-id>` to the same key in the same scope,
through the same draft/commit path the text row already uses. The stored value stays visible and
clearing it stays possible.

## Non-goals

- No change to routing, the classifier transport, or config resolution (`spec-classifier-model.md`
  is the contract; this spec only changes how the value is entered).
- No change to the three `systemOne*` rows, the Scope/Enable rows, or the profile rows.
- The `SystemOne model` row keeps free text: it is an OpenAI-compatible model id for a
  third-party service, not a pi registry model.
- No new dependency (same boundary as `spec-classifier-model.md`).
- Not addressing the report-check quieting that `spec-classifier-model.md` already records.

## Current state (verified in the working tree)

- `src/pi/settings-tui.ts`
  - `SettingsScreenOptions { ctx: ExtensionContext; theme: Theme; done: () => void }` — the command
    handler in `index.ts` already passes the full `ctx`, and the constructor already reads
    `ctx.modelRegistry` (`this.models = modelChoices(options.ctx.modelRegistry)`), so no wiring
    change is needed to reach the registry.
  - `RootStringRow` (`id`, `label`, `key`, `get`, `set`, `defaultHint?`, `describe?`) drives the
    four text rows; every one of them renders `submenu: (current, done) => new NameSubmenu({...})`.
  - `ModelPicker` is a `Container` around a `SelectList`: it puts the empty item
    `{ value: "", label: INHERIT }` first, appends the currently stored value when it is not in the
    list (`"not in the model list"`), and on select calls `done(value === "" ? INHERIT : value)`.
    Its title is hard-coded `Model for "${name}"` and its empty item is hard-coded
    `(inherit)` / `this session's model`.
  - `ProfileSubmenu.openPicker` supplies the choices (`host.modelChoices()`) and swaps the hint
    line to `PICKER_HINT`.
  - `ScreenHost` exposes `modelChoices(): readonly ModelChoice[]`.
- `src/config/models.ts` — `modelChoices(registry)` reads `registry.getAvailable()`, which is the
  **chat** model set. `ModelRegistryLike` is structural so tests can fake it.
- `src/config/draft.ts` — `setClassifierModel(draft, value: string)` applies
  `["classifierModel"] = value`; `setModel(draft, name, model: string | undefined)` already uses
  `undefined` to remove a key, and the profile picker relies on that for `(inherit)`.

## Design

### D1 — which models the picker lists

`classifierRouteFn` resolves the configured reference with
`registry.findOfType("classifier", provider, modelId)`, which only sees models registered with
type `classifier`. The picker must therefore list those, not chat models:

- Add `classifierChoices(registry)` to `src/config/models.ts`, reusing the same sorting
  (label, then value) and value de-duplication as `modelChoices`, but mapping each model to a single
  `label = value = "<provider-id>/<model-id>"` row with no description (the model id alone, with the
  provider display name beside it, is for the chat list; this row reads back as a reference).
- It reads a new optional structural member
  `getModelsOfType?(type: "classifier"): readonly RegistryModel[]` (pi ≥ 1.1.0, synchronous; absent
  from the pinned 0.85.1 types, so it is reached through the structural interface the module
  already uses for fakes).
- No `getModelsOfType`, or no registry, or a throw → `[]`, which the picker already renders as the
  dim `no models available to pick` note.

Rejected: `getAvailable()` (chat models only — every pick would fail `findOfType` and warn
`is not available`). Rejected: `getAvailableOfType("classifier")` (auth-filtered and `Promise`-based;
the screen takes its registry snapshot synchronously in the constructor and has no async load seam).

### D2 — the clear entry

The picker's first row becomes a parameterized empty item. For the classifier row it is
`(none)` / `no classifier; the systemOne* keys apply`, and choosing it removes the key
(`setClassifierModel(draft, undefined)`), so the `systemOne*` keys apply again exactly as they do
when the key is absent. This requires widening `setClassifierModel` to
`value: string | undefined` — the same shape `setModel` already has. The profile row keeps its
existing `(inherit)` / `this session's model` strings byte-for-byte.

Without this entry, replacing the text input would leave no way to unset `classifierModel` from the
screen.

### D3 — arbitrary values (open)

Two options; D3a is recommended.

- **D3a (recommended): picker + a trailing `Type a value…` row** that opens today's `NameSubmenu`.
  Keeps the screen able to enter a reference pi does not list (a classifier registered later, or a
  hand-written `"<provider>/<model-id>"`), which is why the key is a plain string in the first
  place. One extra row, one extra branch, no loss of capability.
- **D3b: picker only**, exactly mirroring the profile `Model` row (the stored off-list value is
  still rendered as `not in the model list` and preserved unless changed). Simpler and more
  consistent, but a value the registry does not list can no longer be entered from the screen.

### D4 — reuse mechanics

- `ModelPicker` options gain `title: string` and
  `empty: { label: string; description: string }`, replacing its hard-coded
  `Model for "${name}"` and `(inherit)` strings. `ProfileSubmenu` passes the old values, so its
  rendering and `done(INHERIT)` contract are unchanged.
- `RootStringRow` gains optional `picker?: RootPickerRow` — a nested object rather than a flat
  `pickerTitle`, so the picker's title, its first entry, its key removal, and its write-in row
  travel together. When present, the row's `submenu` opens the picker (choices from a
  `SettingsScreen` snapshot, hint line `PICKER_HINT`) instead of `NameSubmenu`; the classifier
  row sets `picker: { title: "Classifier model", empty: { label: "(none)", … },
  clear: (draft) => setClassifierModel(draft, undefined), writeIn: { label: "Type a value…", … } }`.
- `SettingsScreen` computes the classifier snapshot once in the constructor next to `this.models`
  (`classifierChoices(options.ctx.modelRegistry)`). It is **not** reached through `ScreenHost`: the
  row's `submenu` is built by `SettingsScreen` itself, so a host method would have no caller.
- Clearing maps the empty item's sentinel to the row's own `clear`, and Esc to no call at all:
  `ModelPicker` reports `""` for the empty entry and `undefined` for a cancel, and each row
  decides what those mean (the profile row maps `""` back to `(inherit)` for `setModel`).

## Acceptance criteria

1. `/subagent-settings`, then selecting `Classifier model`, opens a `SelectList` titled
   `Classifier model` — not a text input — with the empty entry first.
2. The list is every `getModelsOfType("classifier")` model as a single-column row
   `label = value = "<provider-id>/<model-id>"` with no description, sorted by label then value,
   de-duplicated by `<provider>/<id>` — so the row is the exact reference the file will hold and
   the provider is never hidden in a second column.
3. Selecting a model writes `"classifierModel": "<provider>/<model-id>"` into the file for the
   current scope, updates the row's displayed value, and the resulting `config.classifier` resolves
   to `{ provider, model, raw }`.
4. A stored value that is not in the list still renders (as `not in the model list`) and is kept
   unless another row is chosen.
5. The empty entry removes the key from the file, so `config.classifier` is `null` and the
   `systemOne*` keys apply.
6. A context with no `modelRegistry`, or a registry without `getModelsOfType`, renders the picker
   with only the empty entry (and, for D3a, the `Type a value…` row) plus the existing dim note;
   nothing crashes. (This preserves today's registry-less test.)
7. The profile **Model** and **Thinking** rows are unchanged in labels, order and behavior, and all
   pre-existing settings tests pass untouched except where they drive the classifier row.
8. `npm run typecheck` is clean and `npm test` passes; the diff touches only
   `src/config/models.ts`, `src/config/draft.ts`, `src/pi/settings-tui.ts`, `src/config/models.ts`'s
   test, `test/config/draft.test.ts`, `test/pi/settings-command.test.ts`, and this task's docs.

## Resolved questions

1. **D3** — D3a: picker plus a trailing `Type a value…` row that opens the old text field, so a
   reference the registry does not list stays enterable.
2. **D2** — yes: `(none)` is the first entry and removes the key, which is the only way to unset
   `classifierModel` now that the row no longer opens a text field.
3. **Commits** — its own commit, on top of the uncommitted `spec-classifier-model` work.

## Implementation notes

Deviations from the design above, all recorded in `docs/tasks/spec-classifier-model-picker/todo.md`:
`RootStringRow.picker` is a nested object rather than a flat `pickerTitle`; there is no
`ScreenHost.classifierChoices()` (the row's `submenu` is built by `SettingsScreen`, so a host
method would have no caller); and `ModelPicker` reports `""` for the empty entry and `undefined`
for a cancel, so each row decides what those mean.
