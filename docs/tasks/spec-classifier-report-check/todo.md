# Tasks: Report check runs through `classifierModel`

Implements `docs/specs/spec-classifier-report-check.md` (approved). Plan: `plan.md`.
Baseline: `npm test` → 408 pass / 0 fail. Every checkpoint compares against that.

- [x] **C1 — Instructions plumbing.** `RouteInput` in `src/systemone/route.ts` gains optional `instructions?: string`. `classifierRouteFn` passes `input.instructions ?? CHOICE_INSTRUCTIONS` as `questions.profile.instructions`; the legacy `routeOnce` branch ignores it (the HTTP transport builds its own prompt from `criteria`).
  - Acceptance: profile routing behaviour is byte-identical when `instructions` is absent; a caller-supplied `instructions` reaches `registry.classify` verbatim; nothing in the legacy branch changed.
  - Verify: `npm run typecheck`; `npm test -- test/systemone/route.test.ts`
  - Files: `src/systemone/route.ts`, `test/systemone/route.test.ts`

- [x] **C2 — Transport-agnostic report check.** In `src/children/report-check.ts`: add `REPORT_CHECK_INSTRUCTIONS` (the report-check prompt text, moved out of the prose comment), add `createReportDecider(config: TinysubagentConfig, registry?: ClassifierRegistry): (message: string) => Promise<boolean>`, and change `checkReport` to `checkReport(message: string, route: RouteFn): Promise<boolean>`. The decider builds `createRouteFn(config, { registry })` once and calls it with `{ agent: REPORT_CHECK_ROLE, task: clipMessage(message), criteria: REPORT_CHECK_CRITERIA, instructions: REPORT_CHECK_INSTRUCTIONS }`, returning `outcome?.choice === FORGOTTEN`. `SystemOneConfig` and `routeOnce` stop being imported here; the stale "same transport and the same credentials" module comment is rewritten.
  - Acceptance: `checkReport` is transport-agnostic — no HTTP types in its signature. `createReportDecider` with `config.classifier !== null` routes through the classifier; with only `systemOne*` set it routes through `routeOnce`; with neither it never calls anything and returns `false`. No failure path throws; a rejected route fn, a `null` choice, an unknown choice, and a missing answer all yield `false`.
  - Verify: `npm run typecheck`; `npm test -- test/children/report-check.test.ts`
  - Files: `src/children/report-check.ts`, `test/children/report-check.test.ts`

- [x] **C3 — Child wiring.** In `src/children/child.ts`: delete `systemOneDecider()`; build the decider once per child from `createReportDecider(config, ctx.modelRegistry)` using the ctx available at `agent_settled`, keeping the lazy `deps.decidesReport ??` seam. `remindIfUnreported()` keeps its current gate order and reminder cap.
  - Acceptance: a child spawned with `classifierModel` configured and no `systemOne*` keys gets a reminder when its final message is classified `forgotten`; a child with no transport at all settles cleanly and silently (no throw, no delay); `deps.decidesReport` still overrides everything.
  - Verify: `npm run typecheck`; `npm test -- test/children/child.test.ts test/children/spawn.test.ts`
  - Files: `src/children/child.ts`, `test/children/child.test.ts`

- [x] **C4 — Deprecation warning.** In `src/config/config.ts`: add `warnSystemOneDeprecated(read, classifier, warnings)`, called after classifier resolution and before SystemOne resolution (currently `config.ts:546`–`:549`). It collects every `systemOne*` key present in the file — the three top-level keys and project-scoped occurrences — and pushes **one** warning per file listing them.
  - Acceptance: no `systemOne*` key → no warning. Keys present with `classifierModel` set → one warning: `tinysubagent: <keys> is deprecated and ignored while "classifierModel" is set; remove it from <file>.` Keys present without a classifier → one warning: `tinysubagent: <keys> is deprecated and will be removed; set "classifierModel" instead (from <file>).` Multiple keys in one file → a single warning naming all of them. The keys keep working exactly as before (D7).
  - Verify: `npm run typecheck`; `npm test -- test/config/config.test.ts`
  - Files: `src/config/config.ts`, `test/config/config.test.ts`

- [x] **C5 — Docs.** In `README.md`: remove the "the report reminder goes quiet when `classifierModel` is set" limitation, and replace the "will be removed in the future" line with the migration story — set `classifierModel` to `<provider>/<model-id>`, then delete the three `systemOne*` keys; note there is no 1:1 replacement for `systemOneBaseUrl`/`systemOneModel` because `classifierModel` is an in-process model reference, not an endpoint. Keep the existing uncommitted README edit intact.
  - Acceptance: no README sentence claims the reminder goes quiet under `classifierModel`; a `systemOne*`-only user is told both that it still works and what to move to.
  - Verify: `npm run typecheck`; `npm test` (full suite, ≥ 408 pass / 0 fail); read the README diff.
  - Files: `README.md`
