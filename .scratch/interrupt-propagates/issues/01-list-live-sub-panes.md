# 01: Expose the registration's Sub panes as ids

**What to build:** The registration's record of Live sub panes can hand back the panes it holds as a plain list of ids, without asking herdr for the tab's layout first. Pure prefactor: placement, sizing, `drop`, and the existing layout-checked enumeration behave exactly as they do today. It exists so the interrupt path can name every pane this registration holds with no subprocess and no new way to fail.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] The Live sub panes tracker lists the ids it currently holds, in a stable order, with no herdr call.
- [x] A pane id nobody placed is never listed; a dropped id stops being listed.
- [x] Enumeration never mutates the tracked set and never throws.
- [x] The existing layout-checked enumeration, placement, and sizing behaviour are unchanged.
- [x] Tests cover an empty tracker, a placed pane, and a dropped pane, at the existing layout seam.

## Answer

`LiveSubPanes` gained `trackedIds(): string[]` (`src/herdr/layout.ts`). It returns the ids the tracker holds in placement (spawn) order — explicitly not the on-screen order `liveIn` reports — with no herdr call, no probing or pruning, and no mutation, so it cannot throw. An id nobody `place`d is never listed and a `drop`ped id stops being listed; `liveIn`, `planPlacement`, `planResizes`, `place` and `drop` are untouched. Tests sit at the existing `LiveSubPanes` seam in `test/herdr/layout.test.ts` (empty tracker, placed pane, dropped pane, stability/no-mutation).

Commit `20f6588`, merged by `61c8755`.
