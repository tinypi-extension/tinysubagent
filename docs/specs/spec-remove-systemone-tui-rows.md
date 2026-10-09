# Spec: `classifierModel` routing and the removal of the SystemOne settings rows

Status: approved. Intent confirmed by the user before this spec was written.

Supersedes and absorbs the still-valid content of the former `classifierModel` routing spec and the former `classifierModel` settings-picker spec. Both files were deleted on 2026-10-09 and their surviving content lives below as Part A and Part B.

> Supersedes: the former `classifierModel` routing spec (sections: Settings screen, Testing strategy — Settings clause, Out of scope — row presentation clause) and the former `classifierModel` settings-picker spec (sections: Non-goals — SystemOne rows, D2 — the clear entry). The superseded clauses were dropped. The remaining, still-valid content of both files was absorbed into this document as Part A and Part B, and both files were deleted. Also dropped as superseded by this document: the former routing spec's sentence that the three `systemOne*` rows keep their labels and editability, its resolved decision that the SystemOne rows stay visible and editable, and the former picker's non-goal on the SystemOne model row and the `systemOne*` rows.

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
- **D5 — Supersede the old row-order clause.** The former routing spec (§~283, absorbed as Part A below) and
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

---

## Part A — `classifierModel` routing (absorbed from the former routing spec)

> Absorbed from the former `classifierModel` routing spec, deleted 2026-10-09. Superseded clauses are omitted (see the note at the top). Heading levels are shifted down one step under this part heading; heading text is unchanged. This part records the state as it was *before* the SystemOne rows were removed: its row-order statements and its `file:line` references are historical. The authoritative current row set is under "Edit sites" above.

### What it is

A new top-level config key, `classifierModel`, whose value is a pi model reference
`"<provider>/<model-id>"`. When it is set, profile routing is served **in process** by that
classifier model through pi's `ctx.modelRegistry`, instead of by an HTTP call to SystemOne.

The routing *decision* does not change: same candidate profiles, same criteria text, same
"pick one profile per request, otherwise keep `current`" semantics. Only the transport that
answers the question changes — a registry call rather than a POST to `systemOneBaseUrl`.

The point is to let any classifier pi already has credentials for do the routing — TypeSafe
Jev (`typesafe/jev-latest`), the same model through OpenRouter
(`openrouter/typesafe/jev-latest`), OpenAI Decisions (`openai/gpt-6-luna`), a llama.cpp chat
model listed as a classifier — with no separate SystemOne key, endpoint, or model setting.

### Assumptions I'm making

- The `subagent` tool's `execute` has `ctx: ExtensionContext`, and `ctx.modelRegistry` is the
  same registry the pi router example uses. Verified: `src/pi/tool.ts:101` already receives `ctx`
  in `execute` and reads it (`parentModelSpec(ctx)`, `parentThinking(ctx)`).
- A classifier model id may itself contain `/`. So the value splits at the **first** `/` only:
  provider = everything before it, model id = everything after it.
  `openrouter/typesafe/jev-latest` → provider `openrouter`, id `typesafe/jev-latest`.
- Today's one-call-per-request shape is kept. No decision caching is introduced here.
- The classifier's own credentials belong to the provider and never appear in tinysubagent
  config; `classifierModel` holds no secret.
- The classifier only names a profile. Model and thinking level still come from the resolved
  profile, exactly as today.

### Current behaviour (verified, not assumed)

- `src/config/config.ts:32-36` — `SystemOneConfig { apiKey, baseUrl, model }`.
- `src/config/config.ts:56-69` — `TinysubagentConfig { enableProfiles, profiles, env,
  systemOne: SystemOneConfig | null, sources }`.
- `src/config/config.ts:359-412` — `resolveSystemOne(read, warnings)` walks the readable files
  highest-precedence-first. A project-scoped `systemOneAPIKey`/`systemOneBaseUrl` is **inert
  and warned about**; the file that supplies `systemOneAPIKey` is the only file whose URL and
  model count; `systemOneModel` falls back silently.
- `src/config/config.ts:488,498` — `loadConfig` calls `resolveSystemOne` unconditionally and
  returns `{ enableProfiles, profiles, env, systemOne, sources }` plus `warnings`.
- `src/systemone/route.ts:41-43` — `routingActive(config) = enableProfiles && systemOne !== null
  && profileCandidates(config).length > 0`.
- `src/systemone/route.ts:78-101` — `createRouteFn(config, deps?)` returns a `RouteFn` that reads
  `config.systemOne`, calls `routeOnce({apiKey, baseUrl, model, task: input.task, role: input.agent,
  criteria: input.criteria})`, and degrades every failure (including a throw) to `{ choice: null }`.
- `src/systemone/route.ts:111-...` — `routeProfiles(requests, config, deps)` rewrites
  `request.profile` concurrently; unknown, missing, or failing choice → `current` + warn; it also
  warns once when the candidate list exceeds `MAX_ROUTE_CANDIDATES`.
- `src/systemone/route.ts:57-70` — `buildCriteria(config)` maps each candidate to
  `"model X, thinking Y"` (or `"default model and thinking"`).
- `src/pi/tool.ts:71-76,101,115-122` — `ToolDeps.route: RouteFn` is built at registration time in
  `index.ts` and reused for every execute; routing runs only inside
  `if (routingActive(config))`.
- `src/present/describe.ts:54,80` — the `profile` parameter is offered only when
  `enableProfiles && !routingActive(config)`; with routing active it disappears from the schema.
- `src/config/draft.ts:212-243` — `draftSystemOneAPIKey/BaseUrl/Model` via `rootString`, and
  `setSystemOneAPIKey/BaseUrl/Model` via `applyModify(draft, [key], value)`.
- `src/pi/settings-tui.ts:93-98,804-848,889-...` — `SystemOneStringRow { id, label, key, get, set,
  defaultHint? }`, the `systemOneRows` array, and `setSystemOneString(row, value, done)` which
  writes the file and re-reads the row.
- `src/children/child.ts:326-337` — `systemOneDecider()` lazily reads
  `loadConfig(process.cwd(), getAgentDir()).config.systemOne` and returns `false` when it is `null`.
  `src/children/report-check.ts:60-68` posts to SystemOne with that config.
- pi classifier API (verified in pi docs and `examples/extensions/jev-router.ts`):
  `ctx.modelRegistry.findOfType("classifier", provider, id)` → `ModelInfo | undefined`;
  `ctx.modelRegistry.classify(model, { state, questions }, { signal })` → never throws, returns
  `{ provider, model, answers, usage?, stopReason: "stop"|"error"|"aborted", errorMessage? }`,
  where `answers[questionId]` for a `choice` question is
  `{ type: "choice", choice, probabilities, confidence }`.
- Commands: `npm test` (`node --test "test/**/*.test.ts"`), `npm run typecheck` (`tsc --noEmit`).

### Objective

Make `classifierModel` a first-class routing transport, selected by config alone, with
`systemOne*` completely dormant whenever it is set, and with no change to what routing chooses
or how failures degrade. When `classifierModel` is unset, behaviour is byte-for-byte today's.

### Scope check

Independently testable capabilities in this change:

1. config: resolve `classifierModel` across the three scopes, expose `config.classifier`, and
   skip `resolveSystemOne` entirely when it resolves.
2. routing: a classifier-backed `RouteFn` that reaches `ctx.modelRegistry` at execute time.
3. gate: `routingActive` accepts either transport.
4. schema: the `profile` parameter still disappears when only `classifierModel` is set.
5. settings: a "Classifier model" row above the SystemOne rows, in every scope.
6. docs: README key/precedence/failure rows and the SystemOne spec's cross-reference.

Each is small enough to land and verify on its own; 2 and 3 land together.

### Resolution rule (authoritative)

`classifierModel` is a root-object string key, read the same way `rootString` reads the
SystemOne keys, with two deliberate differences:

1. **All three scopes count.** Override (`PI_TINYSUBAGENT_CONFIG`, the only file read then),
   project (`<cwd>/.pi/tinysubagent.jsonc`, then `.json`), and global
   (`<agentDir>/tinysubagent.jsonc`, then `.json`). It is not a credential, so it is not
   restricted to global/override.
2. **No inert-key warning.** A project-scoped value is honored, not ignored.

Precedence is override > project > global; within a scope `.jsonc` wins over `.json`, matching
`loadConfig`'s existing file order. The highest-precedence value that resolves wins.

The value resolves to `null` (unset) when it is absent, blank after trim, or not a string.
Blank and non-string are **not** errors. A value that is a non-blank string but is not a usable
`"<provider>/<model-id>"` — no `/`, an empty provider, or an empty id — also resolves to `null`;
this one case emits a single warning, because a user who typed a value meant it to take effect:

```
tinysubagent: "classifierModel" in <file> is not "<provider>/<model-id>"; ignoring it.
```

`/` is split on the **first** occurrence only, so model ids with slashes survive whole.

On success `loadConfig` returns `classifier: { provider, model } | null` (plus `raw: string` for
messages). When it is non-`null`:

- `resolveSystemOne` is **not called at all** — so `systemOne`-shaped warnings cannot be emitted,
  including the project-scope and missing-key warnings.
- `config.systemOne` is `null`.
- `systemOneAPIKey`, `systemOneBaseUrl`, and `systemOneModel` are never read: a malformed or
  missing key, a missing key with a URL, a project-scoped key — all silent.

When `classifierModel` resolves to `null`, `resolveSystemOne` runs exactly as it does today and
`config.systemOne` is unchanged, byte for byte.

### The `systemOne*` keys are ignored, not errors

Deliberately not built: no warning that `systemOneAPIKey` is superseded, no annotation on the
settings rows, no rejection of a config that sets both. Ignored is silent.

### Routing behaviour

The choice itself is unchanged. `buildCriteria`, `profileCandidates`, the
`"model X, thinking Y"` strings, the candidate cap and its warning, the treatment of `current`,
and the "unknown/missing answer → current + warn" rule all stay exactly as they are, in
`src/systemone/route.ts`, used by both transports.

**The gate.** `routingActive(config)` becomes:

```
enableProfiles && (config.classifier !== null || config.systemOne !== null)
  && profileCandidates(config).length > 0
```

`systemOne` can no longer be the only witness that routing is on, so `src/present/describe.ts`
needs no change: it asks `routingActive` and the `profile` parameter still disappears when only
`classifierModel` is set.

**The seam.** `RouteFn` is built at registration time today, but `ctx.modelRegistry` only exists
inside `execute`. So `ToolDeps.route: RouteFn` becomes
`route: (ctx: ExtensionContext) => RouteFn`, and `execute` builds it inside the existing
`if (routingActive(config))` branch. `index.ts` passes
`(ctx) => createRouteFn(config, { registry: ctx.modelRegistry })`. Tests that inject a stub pass
`() => stub`. This is the only structural change to the tool.

**The classifier route.** `createRouteFn` returns the classifier transport when
`config.classifier !== null`, otherwise the SystemOne transport exactly as today. The classifier
transport, per request:

1. `const model = registry.findOfType("classifier", provider, modelId)`.
   `undefined` is a failure, not a reason to build one.
2. One call:
   `registry.classify(model, { state: { task: input.task, role: input.agent },
   questions: { profile: { type: "choice", instructions: <the same instructions string the
   SystemOne body carries today>, criteria: input.criteria } } }, { signal })`.
   The instructions text and `state` keys are taken from the existing `routeOnce` payload so the
   question reads the same to either model.
3. Read `result.answers.profile`. A `choice` answer whose `choice` is one of the criteria labels
   is the outcome, with its `confidence`. Anything else — `stopReason` not `"stop"`, an
   `errorMessage`, a missing answer, an answer of another type, a label outside the criteria —
   is a failure.
4. Failure returns `{ choice: null }`, which `routeProfiles` already turns into `current` plus one
   warning. There is **no** fallback to SystemOne: those keys were never read.

Timeout: the classifier call gets the same abort budget as the SystemOne call
(`{ signal }`), so a stalled provider degrades like a stalled endpoint instead of holding the
spawn.

### Failure behaviour

Every classifier failure keeps each request's current profile. One warning per failed request,
never one per candidate. Texts are final:

| condition | warning |
| --- | --- |
| value is not `"<provider>/<model-id>"` | `tinysubagent: "classifierModel" in <file> is not "<provider>/<model-id>"; ignoring it.` |
| model not in the registry | `tinysubagent: classifier model "<raw>" is not available; keeping "${current}".` |
| classify error or abort | `tinysubagent: classifier model "<raw>" failed; keeping "${current}".` |

The existing `routeProfiles` warning for an unknown or missing answer is unchanged and is the
only warning produced for a call that did answer off-menu.

### Known consequence: the child-side report decider

`src/children/child.ts:326-337` builds its "is that report done?" decider from
`loadConfig(...).config.systemOne`, and returns `false` when it is `null`. A child that inherits
a config with `classifierModel` set therefore has `systemOne === null`, and the report reminder
stops firing even though the parent routes fine. Nothing in this spec changes that: the child
side would need its own registry-backed call to `report-check.ts`.

Recommendation: out of scope here, and filed as its own change. Any user who sets
`classifierModel` accepts that the reminder goes quiet, and the README must say so. If instead
this must be handled in the same change, the decision is "port `checkReport` to a classifier
call" and it becomes a seventh capability with its own tests in `test/children/`.

### Files

| file | change |
| --- | --- |
| `src/config/config.ts` | `ClassifierConfig`, `resolveClassifier(read, warnings)`, `classifier` on `TinysubagentConfig`, gate `resolveSystemOne` on it |
| `src/systemone/route.ts` | `routingActive` accepts either transport; `createRouteFn` returns classifier or SystemOne transport; classifier `RouteFn` |
| `src/pi/tool.ts` | `ToolDeps.route` → `(ctx) => RouteFn`, built in `execute` |
| `index.ts` | pass `(ctx) => createRouteFn(config, { registry: ctx.modelRegistry })` |
| `src/config/draft.ts` | `draftClassifierModel`, `setClassifierModel` |
| `src/pi/settings-tui.ts` | `CLASSIFIER_ROW` above the SystemOne rows; `SystemOneStringRow`→`RootStringRow`, `setSystemOneString`→`setRootString` |
| `src/present/describe.ts` | none (already asks `routingActive`); verify |
| `src/children/child.ts`, `src/children/report-check.ts` | none in this change (see above) |
| `test/config/config.test.ts` | resolution, precedence, malformed, SystemOne-silence |
| `test/systemone/route.test.ts` | gate, classifier transport, failure paths, `current` |
| `test/pi/tool.test.ts` | `makeRoute(ctx)` seam; profile param gone with classifier-only config |
| `test/config/draft.test.ts` | classifier draft get/set |
| `test/pi/settings-command.test.ts` | row order and write-back |
| `docs/specs/spec-systemone-routing.md` | note that `classifierModel` supersedes it, link here |
| `README.md` | key, precedence, ignored keys, failure row, report-reminder caveat |

### Commands

```
npm test
npm run typecheck
node --test test/systemone/route.test.ts
node --test test/config/config.test.ts
```

### Testing strategy

- Config: value in each scope; override > project > global; `.jsonc` over `.json`; blank,
  non-string, and malformed values each resolve to `null`; malformed warns once and only once.
- Config, the sharp edge: with `classifierModel` set, a config that also has a project-scoped
  `systemOneAPIKey` and a URL without a key produces **no** routing warnings and
  `systemOne === null`; remove `classifierModel` and the same file produces today's warnings —
  one test, both directions.
- Routing: with `classifier: { provider, model }` and `systemOne: null`, `routingActive` is true.
- Classifier transport, injected fake registry: the chosen label lands on `request.profile`;
  `findOfType` miss, `stopReason: "error"`, a thrown call, a missing answer, and an off-menu
  label each keep `current` and warn once; the request never reaches the network.
- Split-on-first-slash: `openrouter/typesafe/jev-latest` reaches
  `findOfType("classifier", "openrouter", "typesafe/jev-latest")`.
- Tool: the stub route is not consulted when `classifierModel` is unset and profiles are off;
  `buildToolDescription` drops `profile` when only `classifierModel` is set.

- Regression: the whole existing SystemOne suite passes untouched.

### Boundaries

- No new dependency; the classifier call is pi's registry.
- No change to `routeOnce` and the SystemOne transport.
- No change to spawn validation, briefs, panes, or the ack format.
- `classifierModel` is not a credential: it is honored in project scope and never warned about
  for being there.
- No decision cache, no memoized profile per agent, no per-turn stickiness.

### Out of scope


- Removing the SystemOne transport, or folding its three keys into `classifierModel`.
- Changing failure semantics: failure is still "keep `current` and warn".
- The child-side report decider (see the consequence section — recommended follow-up).
- Multiple classifiers, per-role classifiers, or a fallback chain between transports.

### Success criteria

1. Config with only `classifierModel: "typesafe/jev-latest"` and `enableProfiles: true` routes
   each subagent through that classifier, and the `profile` parameter is absent from the tool
   schema.
2. The same config with a project-scoped `systemOneAPIKey` present emits no routing warning.
3. Removing `classifierModel` restores today's behaviour exactly, including every existing
   routing warning.
4. Every classifier failure keeps `current` and warns exactly once per request; no HTTP request
   to SystemOne is attempted.
5. `npm test` and `npm run typecheck` pass.

### Decisions at approval

1. **Malformed value: warn once, then ignore.** A non-blank string that is not a usable
   `"<provider>/<model-id>"` emits the one warning above and resolves to unset, which means the
   `systemOne*` keys then apply as they do today. Blank and non-string values stay silent.
2. **The child-side report decider: silence stands in this change.** `checkReport` is not ported
   to a classifier call. The consequence is documented in "Known consequence" and the README
   caveat is part of this change; the port is a follow-up, not a seventh capability.
3. **The three warning strings in "Failure behaviour" are final**, verbatim as written there.
4. **Row label `Classifier model` and description `classifierModel in <file>; "<provider>/<model-id>"`
   are final**, exactly as quoted in this item.

### Resolved decisions

- The key is `classifierModel`, a top-level root string; value `"<provider>/<model-id>"`, split
  on the first `/`.
- Setting it makes every `systemOne*` key inert, silently; `config.systemOne` is `null` and
  `resolveSystemOne` never runs.
- It is honored in project scope as well as global and override, with precedence
  override > project > global.
- Blank or non-string resolves to unset, not to an error.
- `enableProfiles` still gates routing; the candidate set, criteria text, and chosen-profiles
  semantics are unchanged.
- Failure means "keep `current` and warn once"; there is no SystemOne fallback.
- `routingActive` accepts either transport as proof that routing is configured.


---

## Part B — `classifierModel` settings picker (absorbed from the former picker spec)

> Absorbed from the former `classifierModel` settings-picker spec, deleted 2026-10-09. Superseded non-goals and decision D2 are omitted (see the note at the top). Heading levels are shifted down one step under this part heading; heading text is unchanged.

### Problem

On `/subagent-settings`, `classifierModel` is the only model-valued row that must be typed by
hand as `"<provider>/<model-id>"`. The profile **Model** row already opens a `ModelPicker`
(a pi-tui `SelectList`); the classifier row still opens a one-line `Input`.

Typing the reference is error-prone and undiscoverable: the user must know the provider id and
the exact model id, and a value that `findOfType("classifier", provider, modelId)` cannot resolve
does not fail at edit time — it fails later, per request, as
`tinysubagent: classifier model "<raw>" is not available; keeping "current".`

### Goal

Selecting the `Classifier model` row opens a picker over the models the registry can actually run
as classifiers, and selecting one writes `<provider>/<model-id>` to the same key in the same scope,
through the same draft/commit path the text row already uses. The stored value stays visible and
clearing it stays possible.

### Non-goals

- No change to routing, the classifier transport, or config resolution (the contract in Part A
  is authoritative; this spec only changes how the value is entered).
- No new dependency (same boundary as Part A).
- Not addressing the report-check quieting that Part A already records.

### Current state (verified in the working tree)

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

### Design

#### D1 — which models the picker lists

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

#### D3 — arbitrary values (open)

Two options; D3a is recommended.

- **D3a (recommended): picker + a trailing `Type a value…` row** that opens today's `NameSubmenu`.
  Keeps the screen able to enter a reference pi does not list (a classifier registered later, or a
  hand-written `"<provider>/<model-id>"`), which is why the key is a plain string in the first
  place. One extra row, one extra branch, no loss of capability.
- **D3b: picker only**, exactly mirroring the profile `Model` row (the stored off-list value is
  still rendered as `not in the model list` and preserved unless changed). Simpler and more
  consistent, but a value the registry does not list can no longer be entered from the screen.

#### D4 — reuse mechanics

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

### Acceptance criteria

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

### Resolved questions

1. **D3** — D3a: picker plus a trailing `Type a value…` row that opens the old text field, so a
   reference the registry does not list stays enterable.
2. **D2** — yes: `(none)` is the first entry and removes the key, which is the only way to unset
   `classifierModel` now that the row no longer opens a text field.
3. **Commits** — its own commit, on top of the uncommitted `spec-classifier-model` work.

### Implementation notes

Deviations from the design above, all recorded in `docs/tasks/spec-classifier-model-picker/todo.md`:
`RootStringRow.picker` is a nested object rather than a flat `pickerTitle`; there is no
`ScreenHost.classifierChoices()` (the row's `submenu` is built by `SettingsScreen`, so a host
method would have no caller); and `ModelPicker` reports `""` for the empty entry and `undefined`
for a cancel, so each row decides what those mean.

