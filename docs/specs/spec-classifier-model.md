# Spec: `classifierModel` — route profiles with any classifier model

Status: approved. The four open questions are answered (see "Decisions at approval"); nothing
here is built yet.

## What it is

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

## Assumptions I'm making

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

## Current behaviour (verified, not assumed)

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

## Objective

Make `classifierModel` a first-class routing transport, selected by config alone, with
`systemOne*` completely dormant whenever it is set, and with no change to what routing chooses
or how failures degrade. When `classifierModel` is unset, behaviour is byte-for-byte today's.

## Scope check

Independently testable capabilities in this change:

1. config: resolve `classifierModel` across the three scopes, expose `config.classifier`, and
   skip `resolveSystemOne` entirely when it resolves.
2. routing: a classifier-backed `RouteFn` that reaches `ctx.modelRegistry` at execute time.
3. gate: `routingActive` accepts either transport.
4. schema: the `profile` parameter still disappears when only `classifierModel` is set.
5. settings: a "Classifier model" row above the SystemOne rows, in every scope.
6. docs: README key/precedence/failure rows and the SystemOne spec's cross-reference.

Each is small enough to land and verify on its own; 2 and 3 land together.

## Resolution rule (authoritative)

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

## The `systemOne*` keys are ignored, not errors

Deliberately not built: no warning that `systemOneAPIKey` is superseded, no annotation on the
settings rows, no rejection of a config that sets both. Ignored is silent. The three keys keep
their labels, their editability, and their current descriptions.

## Routing behaviour

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

## Failure behaviour

Every classifier failure keeps each request's current profile. One warning per failed request,
never one per candidate. Texts are final:

| condition | warning |
| --- | --- |
| value is not `"<provider>/<model-id>"` | `tinysubagent: "classifierModel" in <file> is not "<provider>/<model-id>"; ignoring it.` |
| model not in the registry | `tinysubagent: classifier model "<raw>" is not available; keeping "${current}".` |
| classify error or abort | `tinysubagent: classifier model "<raw>" failed; keeping "${current}".` |

The existing `routeProfiles` warning for an unknown or missing answer is unchanged and is the
only warning produced for a call that did answer off-menu.

## Settings screen (`/subagent-settings`)

One new row, `CLASSIFIER_ROW = "classifierModel"`, inserted **above** `SYSTEMONE_KEY_ROW`:

- label `Classifier model`
- `classifierModel in <file>; "<provider>/<model-id>"`
- a **model list**, not a text field: the same `ModelPicker` the profile `Model` row opens,
  listing `getModelsOfType("classifier")` as `<provider>/<model-id>`, walked with the
  arrows and saved with Enter. Its first entry, `(none)`, removes the key; a trailing
  `Type a value…` row swaps the list for the one-line field, for a reference the registry
  does not list. Written through the same write-then-reread path.

`spec-classifier-model-picker.md` is the picker's own contract; this spec only names the row.
The row uses the existing machinery: the row shape at `settings-tui.ts:93-98` is generic apart
from its name, so it is renamed (`SystemOneStringRow` → `RootStringRow`) and the array becomes
`rootStringRows`, with the classifier row first and the three SystemOne rows after it, untouched
in label, description, and behaviour. `setSystemOneString` is renamed `setRootString`. In
`src/config/draft.ts`, `draftClassifierModel` + `setClassifierModel` follow the
`rootString`/`applyModify` pattern of their SystemOne siblings.

No row is dimmed, annotated, hidden, or reordered because of `classifierModel`. The three
SystemOne rows do not move.

## Known consequence: the child-side report decider

`src/children/child.ts:326-337` builds its "is that report done?" decider from
`loadConfig(...).config.systemOne`, and returns `false` when it is `null`. A child that inherits
a config with `classifierModel` set therefore has `systemOne === null`, and the report reminder
stops firing even though the parent routes fine. Nothing in this spec changes that: the child
side would need its own registry-backed call to `report-check.ts`.

Recommendation: out of scope here, and filed as its own change. Any user who sets
`classifierModel` accepts that the reminder goes quiet, and the README must say so. If instead
this must be handled in the same change, the decision is "port `checkReport` to a classifier
call" and it becomes a seventh capability with its own tests in `test/children/`.

## Files

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

## Commands

```
npm test
npm run typecheck
node --test test/systemone/route.test.ts
node --test test/config/config.test.ts
```

## Testing strategy

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
- Settings: `classifierModel` row precedes `SystemOne API key`; writing it round-trips through
  the file in all three scopes.
- Regression: the whole existing SystemOne suite passes untouched.

## Boundaries

- No new dependency; the classifier call is pi's registry.
- No change to `routeOnce` and the SystemOne transport.
- No change to spawn validation, briefs, panes, or the ack format.
- `classifierModel` is not a credential: it is honored in project scope and never warned about
  for being there.
- No decision cache, no memoized profile per agent, no per-turn stickiness.

## Out of scope

- Annotating, dimming, hiding, or reordering the SystemOne rows, and warning that they are
  superseded.
- Removing the SystemOne transport, or folding its three keys into `classifierModel`.
- Changing failure semantics: failure is still "keep `current` and warn".
- The child-side report decider (see the consequence section — recommended follow-up).
- Multiple classifiers, per-role classifiers, or a fallback chain between transports.

## Success criteria

1. Config with only `classifierModel: "typesafe/jev-latest"` and `enableProfiles: true` routes
   each subagent through that classifier, and the `profile` parameter is absent from the tool
   schema.
2. The same config with a project-scoped `systemOneAPIKey` present emits no routing warning.
3. Removing `classifierModel` restores today's behaviour exactly, including every existing
   routing warning.
4. Every classifier failure keeps `current` and warns exactly once per request; no HTTP request
   to SystemOne is attempted.
5. `/subagent-settings` shows `Classifier model` above the three SystemOne rows and writes it to
   the selected scope.
6. `npm test` and `npm run typecheck` pass.

## Decisions at approval

1. **Malformed value: warn once, then ignore.** A non-blank string that is not a usable
   `"<provider>/<model-id>"` emits the one warning above and resolves to unset, which means the
   `systemOne*` keys then apply as they do today. Blank and non-string values stay silent.
2. **The child-side report decider: silence stands in this change.** `checkReport` is not ported
   to a classifier call. The consequence is documented in "Known consequence" and the README
   caveat is part of this change; the port is a follow-up, not a seventh capability.
3. **The three warning strings in "Failure behaviour" are final**, verbatim as written there.
4. **Row label `Classifier model` and description `classifierModel in <file>; "<provider>/<model-id>"`
   are final**, exactly as written in "Settings screen".

## Resolved decisions

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
- The settings row sits above the three SystemOne rows, which stay visible and editable.
- `routingActive` accepts either transport as proof that routing is configured.
