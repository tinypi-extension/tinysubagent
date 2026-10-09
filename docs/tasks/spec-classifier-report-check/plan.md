# Plan: Report check runs through `classifierModel`

Implements `docs/specs/spec-classifier-report-check.md` (approved).

- **Repo:** `tinysubagent` @ `71b996a`
- **Baseline:** `npm run typecheck` clean; `npm test` → **408 pass / 0 fail / 0 skipped** (12.5 s, `node --test "test/**/*.test.ts"`)
- **Working tree at plan time:** `README.md` already modified (uncommitted); `docs/specs/spec-classifier-report-check.md` untracked. README edits for this change stack on the existing modification.

## Goal

A subagent that ends its turn without calling `subagent_report` must still be classified when the user has `classifierModel` set — today the check goes silent because a resolved classifier forces `config.systemOne === null`. The legacy `systemOne*` keys stay functional as a fallback and gain a deprecation warning.

## Decisions fixed by the spec

1. **D1** — `RouteInput` gains optional `instructions?: string`. `classifierRouteFn` uses `input.instructions ?? CHOICE_INSTRUCTIONS`; the legacy `routeOnce` branch ignores it. One transport-selection point: everything reuses `createRouteFn`.
2. **D2** — the classifier registry comes from the child's own `agent_settled` ctx (`ctx.modelRegistry`), not threaded from `index.ts`.
3. **D3** — `src/children/report-check.ts` becomes transport-agnostic: `createReportDecider(config, registry)` + `checkReport(message, route: RouteFn)`. `SystemOneConfig` and `routeOnce` leave the module; `systemOneDecider()` is deleted from `child.ts` while the lazy `deps.decidesReport ??` seam stays. Every failure path still lands on `false`.
4. **D4** — `warnSystemOneDeprecated(read, classifier, warnings)` in `src/config/config.ts`, called after classifier resolution and before SystemOne resolution. **One warning per config file**, listing every `systemOne*` key present in that file (project-scoped keys included). Wording:
   - with `classifierModel` set: `tinysubagent: <keys> is deprecated and ignored while "classifierModel" is set; remove it from <file>.`
   - without: `tinysubagent: <keys> is deprecated and will be removed; set "classifierModel" instead (from <file>).`
5. **D5** — no replacement is named for `systemOneBaseUrl`/`systemOneModel`; `classifierModel` is a `provider/model` reference, not an endpoint. The README carries the migration story.
6. **D6** — `classifierModel` always beats `systemOne*`. The legacy transport is a fallback only when `config.classifier === null`.
7. **D7** — deprecated means keep working: no `systemOne*` key is removed by this change, and `REPORT_CHECK_CRITERIA` / reminder-count semantics are untouched.

## Capabilities

| Capability | What it delivers | Depends on |
|---|---|---|
| C1 — instructions plumbing | `RouteInput.instructions`; `classifierRouteFn` honours it | — |
| C2 — transport-agnostic report check | `createReportDecider` + `checkReport(message, route)` in `report-check.ts` | C1 |
| C3 — child wiring | `child.ts` passes its own ctx registry to the decider; `systemOneDecider()` deleted | C2 |
| C4 — deprecation warning | `warnSystemOneDeprecated` in `config.ts` | — (parallel to C1–C3) |
| C5 — docs | README migration note; drop the "goes quiet" limitation | C1–C4 |

Build order: C1 → C2 → C3 → C4 → C5, with C4 shareable in parallel with C1–C3.

## Checkpoints

| Checkpoint | After | Verify |
|---|---|---|
| 1 | C2 | `npm run typecheck`; `npm test` → no regressions vs 408 pass; `report-check` tests pass against a fake `RouteFn` and no longer import `routeOnce` |
| 2 | C4 | `npm run typecheck`; `npm test` → no regressions; the four config warning cases pass; `child.ts` has no `systemOneDecider` |
| 3 | C5 | `npm run typecheck`; `npm test` → final count ≥ baseline, 0 fail; README tells a `systemOne*`-only user how to migrate and no longer claims the reminder goes quiet under `classifierModel` |
