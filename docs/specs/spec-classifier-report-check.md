# Spec: the report check on `classifierModel`, and a deprecation warning for `systemOne*`

Status: **implemented** (`warnSystemOneDeprecated` and the classifier report check are in the
working tree). Originally drafted as "awaiting approval".

## Objective

Two changes, one migration.

1. **Port the child-side report check off the SystemOne HTTP transport.** Today, when
   `classifierModel` is set, `config.systemOne` is `null` (`src/config/config.ts:546-549`),
   so the report decider returns `false` before it ever calls the transport
   (`src/children/child.ts:330-339`). A subagent that finishes its work in prose without
   calling `subagent_report` is therefore never nudged — the exact bug the report check
   exists to prevent. The check must run on the configured classifier, in process.
2. **Keep the three `systemOne*` keys working, and warn that they are deprecated.** They
   are not removed in this change. A config with only `systemOne*` behaves exactly as it
   does today, plus one deprecation warning.

The `classifierModel` routing spec, now Part A of [spec-remove-systemone-tui-rows.md](./spec-remove-systemone-tui-rows.md), shipped (1) as a documented follow-up; this spec is
that follow-up. `README.md:196-198` says "The port of that decider to the classifier is a
follow-up, not part of this change" — that sentence is what this change deletes.

## Assumptions I'm making

- **The child process has its own classifier registry.** The child is a separate pi
  process running the same package (`tinysubagentChild(pi, deps)`,
  `src/children/child.ts:146`), and its event contexts carry `ctx.modelRegistry` — proven
  by `src/children/preflight.ts:84`, which destructures it from the `input` hook's ctx.
  So the registry does **not** need to be threaded from the parent orchestrator through
  `spawn`; the child reads its own.
- `ctx.modelRegistry` on the pinned devDependency (`pi-coding-agent@0.85.1`) still lacks
  `findOfType`/`classify`, so the same one-cast seam used at `index.ts:104` is reused.
- The report check stays a two-verdict decision (`forgotten` / `not-finished`); only the
  transport that answers it changes.
- The legacy SystemOne endpoint's prompt is server-side, so it never needed the
  instruction text; the in-process classifier does. That is the one payload difference.
- "Deprecated" means warn, not break: **no key is removed**, and no existing config's
  routing behavior changes.
- A failed report check must remain invisible. The classifier's failure warnings have no
  surface in the child (no ack to attach them to), and today's SystemOne path is equally
  silent (`checkReport` passes no `deps`, `src/children/report-check.ts:58-88`), so
  dropping them preserves current behavior.

## Current behaviour (verified, not assumed)

- `src/config/config.ts:70-111` — `TinysubagentConfig` carries
  `systemOne: SystemOneConfig | null` (`:79`) and `classifier: ClassifierConfig | null`
  (`:85`); `:76-83` documents that a resolved classifier makes `systemOne` `null` and the
  three keys unread. `:110` — `warnings: string[]` is the load-time channel.
- `src/config/config.ts:513-559` — `loadConfig` collects `warnings`, then
  `:546 const classifier = resolveClassifier(read, warnings);`
  `:549 const systemOne = classifier === null ? resolveSystemOne(read, warnings) : null;`
  With a classifier set, `resolveSystemOne` never runs, so project-scoped keys, a keyless
  URL, and a bad `systemOneModel` all go unmentioned — by design, per Part A of [spec-remove-systemone-tui-rows.md](./spec-remove-systemone-tui-rows.md).
- `src/systemone/route.ts:23-27` — `RouteInput { agent: {name, description}, task, criteria }`.
- `src/systemone/route.ts:141-200` — `classifierRouteFn` resolves the model via
  `registry.findOfType("classifier", provider, modelId)`, calls
  `registry.classify(model, { state: {task, role: input.agent}, questions: { profile:
  { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria: input.criteria }}},
  { signal })` with a `SYSTEMONE_TIMEOUT_MS` (2 s) abort, and degrades "no model",
  a non-`stop` result, a non-string answer, and a throw to `{ choice: null, warning }`.
- `src/systemone/route.ts:202-236` — `createRouteFn(config, deps?)` returns
  `classifierRouteFn(config.classifier, deps)` when `config.classifier !== null`, else the
  legacy branch, whose `:206-207` "no transport resolved: routing is off, and off is
  silent" returns `{ choice: null }` immediately. **Both transports are already selected
  in this one place.**
- `src/children/report-check.ts:23-41` — `REPORT_CHECK_ROLE`, `REPORT_CHECK_CRITERIA`
  (`forgotten` / `not-finished`), `FORGOTTEN`; `:58-88` — `checkReport(message,
  systemOne: SystemOneConfig, deps)` calls `routeOnce` directly from
  `../systemone/client.ts` (HTTP), returns `outcome?.choice === FORGOTTEN`, and catches
  everything to `false`. Its module comment still claims "the same transport and the same
  credentials make the call here" — stale since `classifierModel` landed.
- `src/children/child.ts:285-313` — `remindIfUnreported()` builds the decider once on the
  first `done` settle and caps nudges at `MAX_REPORT_REMINDERS` (2).
- `src/children/child.ts:330-339` — `systemOneDecider()` lazily
  `loadConfig(process.cwd(), getAgentDir()).config.systemOne`, returns `false` when it is
  `null`, else `checkReport(message, systemOne)`. It has no registry.
- `src/children/child.ts:219-253` — the `agent_settled` handler receives `ctx` and ignores
  it (`_ctx`), then calls `remindIfUnreported()` for `settle === "done"`. The `agent_end`
  handler (`:207`) already reads `ctx.signal` from its own ctx.
- `src/children/child.ts:139-145` — `ChildDeps { readFinal?, decidesReport? }`; the
  `decidesReport` seam is the test hook and is not used in production.
- `test/children/report-check.test.ts` — a `SYSTEM_ONE` fixture plus a `fakeFetch` that
  records the POST body; every assertion is transport-shaped.
- `README.md:192-207` — documents `classifierModel`, the inert-key behaviour, and the
  "Known limitation" paragraph this change removes; `:208-232` the deprecated SystemOne
  section.
- `docs/tasks/spec-classifier-model/plan.md` decision 6 — the quiet reminder was an
  accepted, documented consequence, not a bug fix deferred by accident.

## Design

### D1. One transport-selection point: reuse `createRouteFn`

`RouteInput` gains an optional `instructions?: string` (`src/systemone/route.ts:23-27`).
`classifierRouteFn` uses `input.instructions ?? CHOICE_INSTRUCTIONS`; the legacy branch
ignores the field entirely — `routeOnce` sends `role` + `criteria` + `task`, and the
endpoint owns its prompt.

Rejected alternative: a second classifier call path inside `report-check.ts` duplicating
`findOfType`, the timeout, the `stopReason` check, and the answer coercion. That is the
same four-branch degradation written twice, and the two copies would drift.

### D2. The child's own registry, from its own `agent_settled` ctx

`remindIfUnreported(ctx)` takes the context it is already handed (`:219`). The registry
comes from there. No config, `spawn`, or env plumbing is added, and the orchestrator
process is not involved.

This corrects the plumbing guess made during the interview (threading the registry from
`index.ts` through the spawn path). The child is its own pi host; `preflightRefusal(ctx)`
already reads `ctx.modelRegistry` inside the same process.

### D3. `report-check.ts` becomes transport-agnostic

```ts
export const REPORT_CHECK_INSTRUCTIONS =
  "Decide whether the subagent's final message is a finished result it never handed " +
  "back over `subagent_report`, or whether it is not finished. Answer with exactly one " +
  "of the criterion keys.";

export function createReportDecider(
  config: TinysubagentConfig,
  registry?: ClassifierRegistry,
): (message: string) => Promise<boolean>;

export async function checkReport(message: string, route: RouteFn): Promise<boolean>;
```

- `createReportDecider` builds `createRouteFn(config, { registry })` **once** and returns
  the decider; it is the only place the transport is chosen for the report check.
- `checkReport` calls
  `route({ agent: REPORT_CHECK_ROLE, task: clipMessage(message), criteria: REPORT_CHECK_CRITERIA, instructions: REPORT_CHECK_INSTRUCTIONS })`,
  returns `outcome.choice === FORGOTTEN`, and keeps the `catch → false` backstop.
- `SystemOneConfig` and the `routeOnce` import leave the module; the stale module comment
  is rewritten to describe two transports.
- `child.ts` drops `systemOneDecider()` for
  `createReportDecider(loadConfig(process.cwd(), getAgentDir()).config, ctx.modelRegistry as unknown as ClassifierRegistry)`,
  still wrapped in the existing `deps.decidesReport ?? …` seam and still lazy — a child that
  always reports never pays for the lookup.

"Leave it alone" is expressed by the comparison, and needs no new branch:
`{ choice: null }` (no transport configured), classifier unavailable, classifier failure,
timeout, and a `not-finished` verdict all fail `=== FORGOTTEN`.

### D4. Deprecation warning at config load

New helper in `src/config/config.ts`, called from `loadConfig` **between** the classifier
and SystemOne resolution (after `:546`, before `:549`) so the deprecation reads first:

```ts
warnSystemOneDeprecated(read, classifier, warnings);
```

- Walks the successfully-read roots (the same `read` array `resolveClassifier` /
  `resolveSystemOne` receive) and, for each file carrying at least one of
  `systemOneAPIKey` / `systemOneBaseUrl` / `systemOneModel`, pushes **one** warning listing
  the keys present in that file.
- Wording depends on which transport will actually serve:
  - `classifier === null`: `tinysubagent: "systemOneAPIKey" in <file> is deprecated; use "classifierModel" instead.`
  - otherwise: `tinysubagent: "systemOneAPIKey" in <file> is deprecated and ignored while "classifierModel" is set.`
    (Keys pluralised when a file carries more than one.)
- It fires for project-scoped keys and for `systemOneModel` even though those are otherwise
  inert/silent: the point of a deprecation warning is the key's presence, not its effect.
- Exactly one warning per file per load. No other behavior of `resolveSystemOne` changes,
  and its own misuse warnings still run as they do today.

## Commands

```
Typecheck: npm run typecheck
Test:      npm test          # node --test "test/**/*.test.ts"
Smoke:     npm run smoke
```

## Project structure

Unchanged. Source in `src/`, tests mirrored under `test/`, specs in `docs/specs/`, task
files in `docs/tasks/<spec-slug>/`.

## Code style

Existing conventions: 2-tab indentation, tabs for indentation, `type`-only imports, named
exports with JSDoc explaining *why* rather than *what*, no default exports outside
extension entry points. New code follows the shapes above verbatim.

## Testing strategy

`node --test` via `npm test`; every test file sits next to the module it covers. Baseline
to beat: run `npm test` before the first edit and record the count.

- `test/systemone/route.test.ts` — the classifier receives `input.instructions` when
  provided, and `CHOICE_INSTRUCTIONS` when it is not; the legacy branch's request body is
  unchanged by the new field.
- `test/children/report-check.test.ts` — **rewritten** around a fake `RouteFn`: the input
  carries `REPORT_CHECK_ROLE`, `REPORT_CHECK_CRITERIA`, the instructions, and a
  `clipMessage`-clipped task; `forgotten` → `true`; any other choice → `false`; a throwing
  route fn → `false`. The `SYSTEM_ONE` fixture and `fakeFetch` go away.
- `test/children/child.test.ts` — the `decidesReport` seam still short-circuits; a child
  whose config has neither transport ends `done` without a nudge.
- `test/config/config.test.ts` — no `systemOne*` key → no deprecation warning; a key alone →
  the "use classifierModel instead" wording; a key beside `classifierModel` → the "ignored
  while classifierModel is set" wording and still `systemOne === null`; a project-scoped
  `systemOneModel` → warns; a file with two keys → exactly one warning naming both.

## Boundaries

- **Always:** run `npm run typecheck` and the full `npm test` before claiming done; keep the
  `warnings` channel the only user-visible config surface; keep every failure path of the
  report check landing on `false`.
- **Ask first:** removing or renaming any `systemOne*` key; changing `REPORT_CHECK_CRITERIA`
  text or `MAX_REPORT_REMINDERS`; adding a new config key (e.g. a `reportCheck` toggle).
- **Never:** let the report check fail, throw, or delay a settle; add a network call for a
  config with no transport; make the classifier a fallback *behind* SystemOne (classifier
  wins whenever it is set); edit the approved decisions in Part A of [spec-remove-systemone-tui-rows.md](./spec-remove-systemone-tui-rows.md).

## Success criteria

1. With `classifierModel` set and no SystemOne keys, a child that ends a `done` turn without
   `subagent_report` is classified by the classifier and nudged — the reminder is no longer
   quiet. Verifiable in `test/children/report-check.test.ts` (unit) and by
   `npm run smoke` plus a hand run of one profile-routed child.
2. With only `systemOne*` set, the child's behavior is byte-identical to today: no nudge when
   the endpoint says not-`forgotten`, one deprecation warning at load.
3. With no transport configured, no classifier call and no HTTP call is made, and no nudge
   is produced.
4. `npm run typecheck` is clean and `npm test` passes with no failures and no test removed.
5. `README.md` no longer describes the quiet reminder as a limitation, and documents the
   deprecation warning next to the SystemOne section.

## Open questions

1. **Warning wording.** The two strings in D4 are my proposal, including the
   `deprecated and ignored while "classifierModel" is set` half. Approve verbatim or give
   me replacements.
2. **One warning per file, or one per key?** I chose per file, listing the keys present, to
   keep a three-key config from emitting three lines. Push back if you want per-key.
3. **Should the deprecation warning also name the replacement for `systemOneBaseUrl` /
   `systemOneModel`?** Those two have no `classifierModel` equivalent — `classifierModel` is
   a model reference, not an endpoint. My proposal names only `classifierModel` and lets the
   README carry the rest.
