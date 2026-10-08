# Plan: `classifierModel` — route profiles with any classifier model

Implements `docs/specs/spec-classifier-model.md` (approved; all four open questions answered).
Repo `tinysubagent` @ `5706edd`.

**Baseline (verified this run, `5706edd`):** `npm run typecheck` clean; `npm test` →
**367 pass / 0 fail** (7.7 s). Every checkpoint below is compared against that number.

**Goal:** a top-level `classifierModel: "<provider>/<model-id>"` key that lets profile routing
run on pi's built-in classifier instead of the SystemOne endpoint. When it resolves, the three
`systemOne*` keys become silent inert data, `config.systemOne` is `null`, and
`resolveSystemOne` never runs.

## Decisions fixed by the spec

1. Split on the **first** `/` only (`openrouter/typesafe/jev-latest` → provider `openrouter`,
   model `typesafe/jev-latest`).
2. Blank or non-string → unset, silent. Malformed non-blank string → unset, **one warning**,
   then the SystemOne keys apply as today (approval answer 1).
3. `classifierModel` is honored in project scope as well as global and override; precedence
   override > project > global, `.jsonc` over `.json`. No credential, no inert-key warning.
4. `enableProfiles` still gates routing. Candidate set, `buildCriteria`, the cap, `current`
   handling, and "unknown/missing answer → current + warn" are unchanged.
5. Failure = keep `current`, warn once per request, **no** SystemOne fallback — those keys were
   never read.
6. The child-side report decider stays as it is; the reminder going quiet is documented in the
   README (approval answer 2). No port of `checkReport` in this change.
7. The shipped warning strings and the settings label/description are verbatim from the spec
   (approval answers 3 and 4).

## Capabilities

| Module | Deliverable |
|---|---|
| C1 | `src/config/config.ts`: `ClassifierConfig { provider, model, raw }`, `resolveClassifier(read, warnings)`, `classifier` on `TinysubagentConfig`, `resolveSystemOne` gated on it; malformed warning; `test/config/config.test.ts` |
| C2 | `src/systemone/route.ts`: `routingActive` accepts either transport; `createRouteFn` picks the classifier transport when `config.classifier !== null`; classifier `RouteFn` via `registry.findOfType`/`registry.classify`; `test/systemone/route.test.ts` |
| C3 | `src/pi/tool.ts`: `ToolDeps.route` → `(ctx: ExtensionContext) => RouteFn`, built inside the existing `routingActive` branch of `execute`; `index.ts` passes `(ctx) => createRouteFn(config, { registry: ctx.modelRegistry })`; `test/pi/tool.test.ts` |
| C4 | `src/config/draft.ts`: `draftClassifierModel`/`setClassifierModel` via `rootString`/`applyModify`; `src/pi/settings-tui.ts`: `CLASSIFIER_ROW` above the SystemOne rows, `SystemOneStringRow`→`RootStringRow`, `setSystemOneString`→`setRootString`; `test/config/draft.test.ts`, `test/pi/settings-command.test.ts` |
| C5 | Docs: `README.md` (key, precedence, ignored keys, failure row, report-reminder caveat); `docs/specs/spec-systemone-routing.md` cross-reference |
| C6 | Checkpoint: typecheck + full suite + hand-verification of the settings row; one commit |

## Checkpoints

| Checkpoint | After | Expected |
|---|---|---|
| CP0 | — | `5706edd`; 367 pass / 0 fail; typecheck clean |
| CP1 | C1 | typecheck clean; suite green with the new config cases |
| CP2 | C2 | typecheck clean; suite green with the classifier-transport cases; existing SystemOne cases untouched |
| CP3 | C3 | typecheck clean; suite green; tool tests use the `(ctx) => RouteFn` stub |
| CP4 | C4 | typecheck clean; suite green; row order and write-back asserted |
| CP5 | C5–C6 | typecheck clean; `npm test` all pass / 0 fail; docs updated; one commit |

## Result (implemented)

- CP1–CP4 reached sequentially; every checkpoint `npm run typecheck` clean.
- Final automated state: `npm test` → **393 pass / 0 fail** (baseline 367; +26 new tests).
- `src/present/describe.ts` and `src/children/*`: no diff, as the spec predicted.
- Deviations recorded in `todo.md` → Implementation notes: (1) `RouteOutcome.warning?` to carry the
  spec's two distinct failure texts; (2) a structural `ClassifierRegistry` mirror plus one cast at
  the `index.ts` seam instead of bumping the pinned pi devDependency; (3) `CHOICE_INSTRUCTIONS`
  exported from `client.ts` rather than duplicated; (4) `resolveClassifier` fall-through semantics.
- Remaining before close: hand verification of the settings row in a real terminal, then one commit.

`src/present/describe.ts` and `src/children/*` must show **no** diff at CP5 — the spec says
`describe.ts` already asks `routingActive` and needs no change.

## Verification

Automated: `npm test`, `npm run typecheck`, plus the two focused files
(`node --test test/systemone/route.test.ts`, `node --test test/config/config.test.ts`) while
iterating. The classifier transport is tested against an **injected fake registry** — no network
call is made in any test.

Hand, in a real terminal (the live `SettingsList` cannot be driven headlessly): open
`/subagent-settings`, confirm the `Classifier model` row sits above the three SystemOne rows,
type `typesafe/jev-latest`, Esc, `git diff` the target file, and confirm the SystemOne rows are
unannotated.

## Boundaries

- **Never:** add a dependency; change `routeOnce`, `buildCriteria`, `profileCandidates`, or the
  SystemOne transport; cache a decision or memoize a profile; annotate, dim, hide, or reorder
  the SystemOne rows; warn that `systemOne*` is superseded; touch spawn validation, briefs,
  panes, or the ack format.
- **Ask first:** more than one classifier, per-role classifiers, a fallback chain between
  transports, removing the SystemOne transport, or porting `checkReport`.
