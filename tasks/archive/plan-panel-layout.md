# Plan: orchestrator-first panel layout

Implements `docs/spec-panel-layout.md` (awaiting review). The three layout rules were confirmed
with the user before this plan was written: no rebalance on close, later spawns join the live
column, 3/5 is asserted once at column birth.

## Objective

Stop every spawn from splitting the orchestrator. One column on the right, orchestrator at 3/5,
live subs stacked and equal. Today it is `src/spawn.ts:255-263`, one hardcoded
`direction: "right"` off `currentPaneId(env)` and nothing else.

Geometry cannot be set at open time — `herdr plugin pane open` has no ratio flag on the installed
0.8.2 — so the pane is opened first and shaped second, by `herdr pane resize`.

## Shape of the change

```
spawnOne(request, context)
  │
  ├─ read  pane layout ──► planPlacement(layout, orches, live)
  │                          │  live ∩ this tab empty → { direction:"right", target: orches }
  │                          └─ else                   → { direction:"down",  target: bottom-most live }
  ├─ herdrPaneOpen(...)  ──► paneId            (unchanged call, new target/direction arguments)
  ├─ live.place(paneId)
  └─ read  pane layout ──► planResizes(...)  ──► N-1 best-effort resizes
                             │  born column → one resize: orches to 3/5
                             └─ append      → one resize per boundary, top-down, equal heights
```

New module `src/layout.ts` holds the planner (pure) and the tracker. `src/herdr.ts` gains two
wrappers (`herdrPaneLayout`, `herdrPaneResize`) beside the existing five. `src/spawn.ts` owns the
sequencing. `index.ts` gains the tracker instance and one `drop` call.

## Implementation order

Dependency-ordered vertical slices. Each is test-first and leaves `npm run typecheck` and
`npm test` green; no slice is a half-applied state.

1. **Test harness: a scripted herdr stub.** `withHerdrStub` (`test/herdr.test.ts:191`) answers one
   payload for one call. The sequence tests need a queue of payloads and per-invocation argv. Add
   `withHerdrStubScript(payloads, fn)` alongside it and leave the existing helper untouched, so no
   existing test moves. Independent of every later slice — do it first so slices 4-6 are testable
   at all.
2. **`src/herdr.ts`: the two wrappers.** `herdrPaneLayout(paneId)` → `TabLayout | null`
   (`runHerdrJson` + `unwrap`; `null` on any failure, missing `layout`, or a non-array `panes`).
   `herdrPaneResize(paneId, direction, amount)` → `Promise<boolean>` (`runHerdrQuiet`). Argv
   order pinned by test: `pane resize --direction D --amount A --pane ID`, and
   `pane layout --pane ID`. No call site yet.
3. **`src/layout.ts`: `planPlacement`.** Pure. Born-vs-append detection is
   `live ∩ tab.panes ≠ ∅`, the append target is the bottom-most live pane by `rect.y`, the birth
   target is the orchestrator. A live id the tab does not report is ignored.
4. **`src/layout.ts`: `planResizes`.** Pure. Birth: `delta = orchesWidth − 0.6·(orchesWidth +
   newWidth)` → one op at `|delta| / W`. Append: the equal-height pass over the column panes
   ordered by `rect.y`. Both clamp-guarded (`|delta| < 1` ⇒ no op) and total.
5. **`src/layout.ts`: `LiveSubPanes`.** `place`/`drop`/`liveIn`, with the prune inside `liveIn`.
6. **`src/spawn.ts`: wire it.** Placement before the open, resize pass after, both best-effort.
   `SpawnContext` carries the tracker; no tracker ⇒ no placement control and the old
   `direction: "right"` behaviour, so `scripts/smoke.ts` and the existing tests keep working
   during the transition. `spawnOne` must still return `{ok:true}` with every herdr call failing.
7. **`index.ts`: the instance.** One `LiveSubPanes` at registration, passed into `SpawnContext`
   (`index.ts:460`), dropped at the completion close (`index.ts:403`).
8. **`scripts/smoke-layout.ts` + `package.json` script.** Real end-to-end geometry assertion.
9. **Docs.** `docs/intent.md:9`, README (line 4, the "Single or parallel" bullet, the lifecycle
   list at 135-140), and the header docstring of `src/layout.ts`.

Slices 3-5 are sequential (same module, same types). Slice 9 is independent of 3-8 — it documents
the approved spec, not the code — and may run in parallel; file ownership is disjoint (slice 9
owns `docs/intent.md` and `README.md`, the code slices own `src/`).

## Risks

| Risk | Mitigation |
|---|---|
| Confusing "which divider does `--pane X` move" in a 3-deep stack | Pinned by probe in the spec (address `pane_{k+1}` with `up`/`down`); unit fixtures are the probe's real rects |
| Resize deltas computed from an assumed open ratio | No assumption anywhere: every delta comes from a read taken after the open |
| Planner drifting into herdr I/O and becoming untestable | `src/layout.ts` does no I/O — no `execFile`, no `process.env`. Hard rule, checkable by grep |
| A layout failure becoming a spawn failure | Both wrappers best-effort, `planResizes` total, dedicated spawn test |
| Tests passing against a stub that answers the wrong call | Scripted stub keyed by call index, with the argv of each invocation asserted separately |
| The 3/5 pass firing on every spawn and fighting the user | Only when the column is born, which the tracker defines; one test asserts a later spawn emits no root-divider op |
| Rounding making "equal" impossible to assert | Tolerance ±1 row (spec); the smoke script asserts the tolerance, not exactness |
| `live` accumulating panes that are really gone | The tab's pane list is the oracle on every spawn |

## Out of scope

See the spec: no rebalance on close, no drag-snapback, no user-pane re-layout, no config knob, no
nested delegation, no herdr version bump, no layout event subscription.

## Verification checkpoints

After every slice: `npm run typecheck` and `npm test`. After slice 8: `npm run smoke-layout`
inside a herdr session with the plugin linked (it is — this repo is developed in one), plus
`npm run smoke` unchanged and green, since it shares `spawnOne`. Final gate: `docs/intent.md`
describes the two-column rule, and `grep -rn 'direction: "right"' src index.ts` returns only the
no-tracker fallback in `spawnOne` plus the `PaneOpenOptions` default.
