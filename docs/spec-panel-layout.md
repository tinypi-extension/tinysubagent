# Spec: orchestrator-first panel layout

Status: awaiting review. Extends `docs/intent.md`; that document is the contract and this one
must not contradict it without editing the conflicting line first. `docs/intent.md:9`
("each in a right-hand pane") is the line this change sharpens, and the docs task edits it.

Confirmed intent (interview, 2026-09-11) — the three decisions below were each put to the user
and answered:

1. A sub pane closing does **not** rebalance the others. The layout is set at spawn time and
   never revisited because a child left.
2. A later spawn **joins the live column** and re-divides every live sub equally, even though a
   close does not. "N subs" means all live subagent panes, not one batch.
3. 3/5 is asserted **once**, when the column is born. A divider the user dragged by hand is never
   snapped back. It is measured against the orchestrator pane's own rect, not the tab.

## Assumptions I'm making

1. The layout is **cosmetic**. Every herdr call it adds is best-effort, like `herdrPaneRename`
   (`src/spawn.ts:267`): a layout failure never fails a spawn, never warns, and never changes an
   acknowledgement line. Panes are open and usable even when the geometry is wrong.
2. Live sub panes are tracked **in memory, per extension instance**, not inferred from pane
   labels or herdr geometry. A `Set` of pane ids we opened, pruned against the tab's live pane
   list on every spawn. `pane layout` is the liveness oracle; no extra `pane get` probing.
3. `herdr plugin pane open` has no ratio flag on the installed herdr, so geometry is set
   **after** the pane exists, by `herdr pane resize`. No dependency on a newer herdr.
4. The existing `MAX_PARALLEL_TASKS = 4` cap is per tool call and stays. Sequential calls can
   leave more than 4 live subs; the column then divides by the live count, whatever it is.
5. Detection is "live pane ∩ the orchestrator's tab". A sub the user dragged into another tab is
   still tracked as live but is not part of this tab's column — and a column with no pane in this
   tab counts as not existing, so the next spawn splits right again.

→ Correct these now or I proceed with them.

## Objective

Today every spawn splits the **orchestrator** pane (`src/spawn.ts:255-263`,
`--direction right`), so N children produce N+1 side-by-side columns and each one is narrower
than the last. Past two children the layout is unusable: the orchestrator — the pane the human
actually types into — is the thing that keeps shrinking.

Replace that with a two-column shape: the orchestrator keeps 3/5 of its rect, and every live
subagent shares a single right-hand column, stacked and equal in height.

```
        before                          after
┌────┬──┬──┬──┐              ┌──────────────┬───────┐
│ or │s1│s2│s3│              │              │  s1   │
│ ch │  │  │  │              │  orchestr.   ├───────┤
│ es │  │  │  │              │    3/5       │  s2   │
│    │  │  │  │              │              ├───────┤
│    │  │  │  │              │              │  s3   │
└────┴──┴──┴──┘              └──────────────┴───────┘
```

**User:** whoever is orchestrating — the human watching the panes, and the model driving the
tool (whose own pane is what stops collapsing).

**Success:** one spawn gives a 60/40 split; three give a 60% orchestrator and three equal-height
children on the right; adding a child to a live column re-divides the column equally; a child
finishing leaves the rest exactly where they are.

## Scope check

One capability, one module (`src/layout.ts`) plus two thin wrappers in `src/herdr.ts`. No
capability map.

## What herdr actually does (probed, 0.8.2)

Everything below was verified against the live session on 2026-09-11; the numbers are real
measurements, not readings of the docs. A `tab create` → `pane split` scratch tab was used and
closed again.

| Fact | Evidence |
|---|---|
| `plugin pane open` has no size/ratio flag | `--help`: only `--plugin --entrypoint --placement --workspace --target-pane --direction --cwd --env --focus/--no-focus`. The later `--width/--height` are popup dims and do not apply to `--placement split`. |
| `resize --amount` is a fraction of the **split node's rect**, not the tab | 58-row node, `--amount 0.1` → 6 rows moved. 29-row node, `--amount 0.1` → ~3 rows. Root split, 211 cols, `--amount 0.3` → 63 cols. |
| `--direction` is the way the **divider** moves | `--pane <right> --direction right --amount 0.6` took the root ratio 0.4 → 0.9 (left pane grew). `--pane <right> --direction left --amount 0.3` took it 0.9 → 0.6. |
| The pane argument selects the divider nearest it in that direction | 3-deep stack `A/B/C`: `--pane B --direction down` moved the divider *below* B (ratio 0.5 → 0.6); `--pane B --direction up` moved the divider *above* B (0.5 → 0.4). |
| An edge pane still moves the nearest divider, in the requested direction | bottom pane `C`: `--direction up` moved the divider above C up (C grew), and `--direction down` moved that same divider **down** (C shrank). |
| Ratios clamp to ~0.1–0.9 | 211 cols, `--amount 0.6` from 0.4 landed on 0.9 → 190/21, i.e. a 10% floor. |
| `pane layout` is tab-wide, with rects and split ratios | `result.layout = {tab_id, area, focused_pane_id, panes[{pane_id, rect{x,y,width,height}}], splits[{id, direction, ratio, rect}], zoomed}`. |
| A plain split defaults to 0.5 | `pane split --direction down` → ratio 0.5. |

Two consequences that shape the implementation:

- Geometry must be computed from **observed rects**, never from an assumed starting ratio.
  The plugin pane's open ratio is not documented, so the planner reads the layout after the
  open and derives both the ratio delta and its sign from what is actually there.
- Every operation we need is expressible as "move the divider between two adjacent panes":
  `resize(pane_{k+1}, "up", amount)` for a horizontal divider, and
  `resize(<a column pane>, "left"|"right", amount)` for the root divider. No split ids needed.

## The algorithm

### Column birth (no live sub pane in this tab)

1. `herdrPaneOpen({ targetPaneId: orchestrator, direction: "right" })` — unchanged.
2. Read `pane layout --pane <orchestrator>`.
3. `W = width(orchestrator) + width(new pane)`; `delta = width(orchestrator) - 0.6·W`.
4. If `|delta| ≥ 1`: `resize(<new pane>, delta > 0 ? "left" : "right", |delta| / W)`.

### Column append (live sub panes in this tab)

1. `herdrPaneOpen({ targetPaneId: <bottom-most live sub pane>, direction: "down" })`.
2. Read `pane layout`.
3. Take the live sub panes present in this tab, **ordered top to bottom** by `rect.y`. They are
   contiguous leaves sharing one `x` and `width`; `C = Σ height`, `t = C / N`.
4. For `k = 1 .. N-1`, in that order, `H_k = C - (k-1)·t`, `delta = height(pane_k) - t`:
   if `|delta| ≥ 1`, `resize(pane_{k+1}, delta > 0 ? "up" : "down", |delta| / H_k)`.

`H_k` is the rect of the split node spanning `pane_k .. pane_N`, which is why the top-down order
matters: by the time `k` is resized, everything above it is already at its target, so the node
height is `C - (k-1)·t` and can be computed from the single initial read. Later resizes only
touch the region below, so one read is enough for the whole pass.

Rounding is herdr's: each resize rounds to whole rows, so a pass can settle within ±1 row of
equal. That is acceptable and is what the tolerance in the tests asserts.

Degradation, documented not fought: past ~9 live subs `1/N` hits the 0.1 ratio floor and the
last panes stop being equal. Nothing breaks; the layout just stops being uniform.

## The interface

New module `src/layout.ts`, and it is deliberately almost all pure functions — the plumbing is
two wrappers in `src/herdr.ts`.

```ts
export interface Rect { x: number; y: number; width: number; height: number }

/** Tab geometry as `pane layout` reports it. */
export interface TabLayout {
  tabId: string | null;
  panes: { paneId: string; rect: Rect }[];
}

export interface ResizeOp {
  paneId: string;
  direction: "left" | "right" | "up" | "down";
  amount: number;                       // fraction of the split node's rect
}

/** Where the next pane goes, and what to do once it is open. */
export interface Placement {
  targetPaneId: string;                 // split target
  direction: "right" | "down";
  bornColumn: boolean;                  // the 3/5 pass applies
}

export function planPlacement(layout: TabLayout, orchestratorPaneId: string, live: readonly string[]): Placement;
export function planResizes(layout: TabLayout, orchestratorPaneId: string, live: readonly string[], newPaneId: string): ResizeOp[];
```

`planPlacement` runs **before** the open, on a freshly read layout, so the append target is the
real bottom-most live pane. `planResizes` runs after, on a second read (`newPaneId` is needed
only to find the column in the birth case). Both are total: an unrecognisable layout yields
`[]` resizes and a `"right"` placement, never a throw.

`src/herdr.ts` gains two wrappers in the existing house style — `herdrPaneLayout(paneId)` with
`parseHerdrJson` + `unwrap`, returning `null` on any failure, and `herdrPaneResize(...)` as a
`runHerdrQuiet` best-effort call. `PaneOpenOptions`/`herdrPaneOpen` are untouched.

`src/spawn.ts` owns the sequencing, because it already owns the open:

```
place   = planPlacement(read(), orchestrator, live)      // best-effort: [] on a failed read
paneId  = herdrPaneOpen({ targetPaneId: place.targetPaneId, direction: place.direction, ... })
live.add(paneId)
for (op of planResizes(read(), orchestrator, live, paneId)) resize(op)   // never awaited-twice, never throws
```

A failed layout read means no resize pass, not a failed spawn: the pane is open and the child is
running, which is the only part that matters.

### Live-pane tracking

```ts
export class LiveSubPanes {
  place(paneId: string): void;                 // after a successful open
  drop(paneId: string): void;                  // on completion-close and on tool teardown
  liveIn(tab: TabLayout): string[];            // tracked ∩ this tab's panes, top-to-bottom
}
```

One instance per extension registration, built next to the existing tool closure in
`index.ts` and handed to `spawnOne` through `SpawnContext` (added at `index.ts:460`). The prune
happens inside `liveIn`: a tracked id the tab no longer reports was closed by someone else, so
it is dropped there rather than by a `pane get` probe per pane.

`index.ts:403` (`outcome.kind === "completed"` → `herdrPaneClose`) is the one close site inside
the extension; it drops from the tracker. A failed child keeps its pane open, so it stays
tracked. No rebalance is triggered from there — that is confirmed decision 1.

## Out of scope

No rebalance on close (decision 1). No snapping back a hand-dragged divider (decision 3). No
touching the user's own splits elsewhere in the tab, and no re-layout of panes the extension did
not open. No nested delegation. No herdr version bump, no `--ratio`-at-open dependency. No
config knob: the 3/5 and the equal division are fixed, and the ratios stay out of
`tinysubagent.jsonc` until someone actually asks to tune them. No `pane layout` event
subscription — layout is read per spawn, never watched.

## Risks

| Risk | Mitigation |
|---|---|
| Wrong divider targeted in a 3-deep stack (the middle-pane ambiguity) | Probed and pinned above: address `pane_{k+1}` with `up`/`down`; unit-tested against the exact rect fixtures from the probe |
| Assuming the plugin pane opens at 0.5 and being subtly wrong on another herdr | Nothing assumes a starting ratio — every delta comes from a read taken after the open, and a pass whose panes are already at target emits zero ops |
| Layout calls slowing the spawn path | 1–3 extra herdr execs (~50 ms each locally), all after the pane is open; the child is already running while they happen |
| A resize pass fighting a user mid-drag | One pass per spawn, no polling, no retry; per decision 3 the root divider is only ever touched in the birth case |
| Layout failure surfacing as a spawn failure | Both wrappers are best-effort and `planResizes` is total; a dedicated test pins "spawn still returns ok when every layout call fails" |
| Tracker drifting from reality (pane closed by the user, tab moved) | The tab's live pane list is the oracle on every spawn; a stale id is dropped, never used as a split target |
| The `withHerdrStub` harness only scripts one response per test | Extend it to a queued/scripted stub before writing the sequence tests (plan slice 1) |

## Verification

- `npm run typecheck`, `npm test`.
- `test/layout.test.ts` — pure planner: birth at 3/5, appends to a 1/2/3-pane column, the
  middle-pane divider targeting, already-equal ⇒ no ops, dead-pane prune, other-tab panes
  ignored, degraded `N > 9`, garbage layout ⇒ no throw.
- `test/herdr.test.ts` — `herdrPaneLayout` parsing (envelope, missing fields, non-JSON ⇒ null)
  and `herdrPaneResize` argv, against the scripted stub.
- `test/spawn.test.ts` — spawn succeeds with every layout call failing.
- `scripts/smoke-layout.ts` — the honest one, because only real herdr can prove the geometry:
  spawn two children, assert the orchestrator lands within ±1 col of 60% of the split and the two
  sub rects within ±1 row of each other, then close everything. Needs a live herdr session with
  the plugin linked (already the case for `npm run smoke`).
