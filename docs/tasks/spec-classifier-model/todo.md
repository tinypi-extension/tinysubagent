# Todo: `classifierModel` — route profiles with any classifier model

Implements `docs/specs/spec-classifier-model.md` per `docs/tasks/spec-classifier-model/plan.md`.
Baseline at `5706edd`: typecheck clean, `npm test` → 367 pass / 0 fail.

- [x] **C1 — config resolution.** `ClassifierConfig { provider, model, raw }`; `classifier` on
  `TinysubagentConfig`; `resolveClassifier(read, warnings)` splits the raw string on the **first**
  `/`, returns `null` for absent/blank/non-string, and for a malformed non-blank string pushes
  the spec's warning once and returns `null`. `loadConfig` gates `resolveSystemOne` on a
  non-`null` classifier: when it resolves, `systemOne` is `null` and the three `systemOne*` keys
  are never read (no project-scope, missing-key, or URL-without-key warnings).
  Tests: value in each scope; override > project > global; `.jsonc` over `.json`; blank /
  non-string / malformed each resolve to `null`; malformed warns exactly once; one
  both-directions case — with `classifierModel` set a project-scoped `systemOneAPIKey` plus a
  keyless URL warn nothing and `systemOne === null`, and removing it restores today's warnings;
  `openrouter/typesafe/jev-latest` splits into `openrouter` + `typesafe/jev-latest`.
  - Files: `src/config/config.ts`, `test/config/config.test.ts`
- [x] **C2 — routing gate + classifier transport.** `routingActive(config)` becomes
  `enableProfiles && (config.classifier !== null || config.systemOne !== null) &&
  profileCandidates(config).length > 0`. `createRouteFn(config, deps?)` returns the classifier
  transport when `config.classifier !== null`, else the existing SystemOne transport unchanged.
  The classifier transport, per request: `registry.findOfType("classifier", provider, modelId)`
  (`undefined` = failure, never built here), one `registry.classify(model, { state: { task,
  role: input.agent }, questions: { profile: { type: "choice", instructions: <same text as the
  SystemOne body>, criteria: input.criteria } } }, { signal })`, then accept a `choice` answer
  whose label is in the criteria. Anything else returns `{ choice: null }` — `routeProfiles` turns
  that into `current` + one warning. No SystemOne fallback.
  Tests, injected fake registry: chosen label lands on `request.profile`; `findOfType` miss,
  `stopReason: "error"`, a thrown call, a missing answer, and an off-menu label each keep
  `current` and warn once; `routingActive` is true with `classifier` set and `systemOne: null`;
  no network call in any case; the existing SystemOne suite passes untouched.
  - Files: `src/systemone/route.ts`, `test/systemone/route.test.ts`
- [x] **C3 — the `(ctx) => RouteFn` seam.** `ToolDeps.route: RouteFn` →
  `route: (ctx: ExtensionContext) => RouteFn`, built inside the existing `if
  (routingActive(config))` branch of `execute` so `ctx.modelRegistry` is available; `index.ts`
  passes `(ctx) => createRouteFn(config, { registry: ctx.modelRegistry })`; injected test stubs
  pass `() => stub`.
  Tests: the stub route is not consulted when `classifierModel` is unset and profiles are off;
  `buildToolDescription` drops the `profile` parameter when only `classifierModel` is set (via
  `routingActive`, with no `describe.ts` change).
  - Files: `src/pi/tool.ts`, `index.ts`, `test/pi/tool.test.ts`
- [x] **C4 — settings row + config draft.** `src/config/draft.ts`: `draftClassifierModel` +
  `setClassifierModel` following the `rootString`/`applyModify` pattern. `src/pi/settings-tui.ts`:
  `CLASSIFIER_ROW = "classifierModel"` (`Classifier model`, description
  `classifierModel in <file>; "<provider>/<model-id>"`) inserted above `SYSTEMONE_KEY_ROW`;
  `SystemOneStringRow` → `RootStringRow`, `systemOneRows` → `rootStringRows` (classifier first,
  the three SystemOne rows after it, untouched in label, description, and behaviour),
  `setSystemOneString` → `setRootString`. No row is dimmed, annotated, hidden, or reordered.
  Tests: the classifier row precedes `SystemOne API key`; writing it round-trips through the
  file in all three scopes; classifier draft get/set.
  - Files: `src/config/draft.ts`, `src/pi/settings-tui.ts`, `test/config/draft.test.ts`,
    `test/pi/settings-command.test.ts`
- [x] **C5 — docs.** `README.md`: the key, `"<provider>/<model-id>"`, precedence, that the three
  `systemOne*` keys are then ignored silently, the failure row, and the caveat that the child-side
  report reminder goes quiet while `classifierModel` is set. `docs/specs/spec-systemone-routing.md`:
  note that `classifierModel` supersedes it and link to this spec.
  - Files: `README.md`, `docs/specs/spec-systemone-routing.md`
- [ ] **C6 — checkpoint + hand verification + commit.** Automated checkpoint done (below); hand verification and commit pending. `npm run typecheck` clean; `npm test`
  all pass / 0 fail. Confirm `git diff` shows no change to `src/present/describe.ts` or
  `src/children/*`. Hand, in a real terminal: `/subagent-settings` shows `Classifier model` above
  the three SystemOne rows, typing `typesafe/jev-latest` round-trips through the file, and the
  SystemOne rows are unannotated. Result recorded here.
  - Files: `docs/tasks/spec-classifier-model/plan.md`, `docs/tasks/spec-classifier-model/todo.md`

## Implementation notes

**Checkpoint (CP5, automated).** `5706edd` baseline was 367 pass / 0 fail, typecheck clean.
After C1–C5: `npm run typecheck` clean; `npm test` → **393 pass / 0 fail** (8.9 s).
`git diff --stat` confirms `src/present/describe.ts` and `src/children/*` are untouched.

**Deviations from the plan (all deliberate, all commented in code):**

1. **`RouteOutcome.warning?: string` added** (`src/systemone/route.ts`). The spec says a classifier
   failure returns `{ choice: null }` and that `routeProfiles` turns that into `current` plus one
   warning — but the spec's Failure table requires two *distinct* verbatim texts (“is not available”
   vs “failed”), and `routeProfiles` cannot tell them apart from a bare `null` (and today it is
   silent on `null`). The optional `warning` carries the transport's diagnosis; `routeProfiles`
   emits it once. It is set only when `choice` is null, and the existing warning fires only for a
   non-empty string choice, so no request can warn twice. A SystemOne `{ choice: null }` stays
   silent, so the existing SystemOne suite is unchanged.
2. **Structural `ClassifierRegistry`, no dependency bump.** The repo's devDependency is
   `@earendil-works/pi-coding-agent@^0.85.1`, installed 0.85.1, whose `ModelRegistry` has no
   `findOfType`/`classify`; the runtime pi (1.1.0) does. Per the spec's “no new dependency”
   boundary, `src/systemone/route.ts` declares a minimal structural mirror of that surface and
   `index.ts` casts once at the seam (`ctx.modelRegistry as unknown as ClassifierRegistry`). Chosen
   over bumping the devDependency; revert-proof because the runtime object already satisfies the
   shape.
3. **`CHOICE_INSTRUCTIONS` exported from `src/systemone/client.ts`** (one `export` keyword, value
   unchanged). The classifier must send “the same instructions string the SystemOne body carries”,
   so it is imported rather than duplicated. `routeOnce` and the SystemOne transport are
   byte-identical.
4. **`resolveClassifier` fall-through:** a file without `classifierModel` falls through; a blank or
   non-string value is silent and falls through; the first malformed non-blank value warns exactly
   once per load and falls through; the first valid value wins. Consequence: `classifierModel` is
   trimmed and split on the first `/` only (`openrouter/typesafe/jev-latest` → `openrouter` +
   `typesafe/jev-latest`).

**Hand verification (real terminal):** pending — the live `SettingsList` cannot be driven
headlessly. To be recorded here: `/subagent-settings` shows `Classifier model` above the three
SystemOne rows; typing `typesafe/jev-latest` round-trips through the file; the SystemOne rows are
unannotated.

**Commit:** pending hand verification.
