# 02: Relay an orchestrator interrupt to every live child

**What to build:** Interrupting the orchestrator's turn sends one Esc into every pane this registration holds — the Batch in flight and any earlier child still live, idle children included — and then returns the call at once. Nothing is closed, nothing is killed, and the relay never waits for an answer. A relay that cannot be delivered is silent: no warning, no failure, no close, and the rest of the fan-out still happens. A second Esc changes nothing. An interrupt that lands while Spawns are still opening stops the remaining requests from launching, keeping the Labels of children that started and releasing those of requests that never did.

**Blocked by:** 01 (Expose the registration's Sub panes as ids)

**Status:** resolved

- [x] Interrupting the call's turn relays one Esc into each of the registration's Live sub panes before the waits end, including children of earlier calls.
- [x] Idle children are relayed to as well: mid-turn state is not detected, and this bluntness is recorded in the code's own account of the feature.
- [x] The call returns as soon as the relay is issued; no relay is awaited.
- [x] No `pane close` and no process kill happens anywhere on this path.
- [x] A relay that fails — a pane already gone, a herdr error — produces no warning, no failure and no change to the result, and does not stop the other relays.
- [x] A second Esc, or an Esc once the call has already aborted, is a no-op and never escalates to closing panes.
- [x] Every abort of the call's signal relays the interrupt, whatever aborted it.
- [x] An abort mid-spawn leaves the remaining requests unlaunched; started children keep their Labels, unlaunched requests release theirs.
- [x] Tests at the tool call's existing execution seam assert the herdr commands actually received: one `send-keys … esc` per live child, none for a dropped pane, and no `pane close`.
- [x] Tests cover the silent-failure and second-Esc cases, and the mid-spawn case, at that same seam.

## Answer

The relay trigger lives in the batch watcher, as the spec's Implementation Decisions require: `watchBatch.forward()` (`src/pi/watch-batch.ts`) is guarded by `let forwarded = false`, relays `relayInterrupt(columns.trackedIds())`, then aborts the child controllers. `relayInterrupt` (`src/children/interrupt.ts`) issues one un-awaited `herdrPaneSendEsc(id)` per tracked id, swallows every rejection, never throws and never escalates; one pane failing does not stop the fan-out. The scope is every pane this registration holds, idle children and earlier calls' children included — bluntness recorded in the module's account and in ADR 0002. No `pane close` and no kill exists on the path. `tool.ts` keeps exactly one `if (signal?.aborted) break;` before each spawn, so an abort mid-spawn leaves remaining requests unlaunched while started children keep their Labels.

Tests at the tool seam assert the exact herdr argv: one `send-keys … esc` per live child, none for a dropped pane, no `pane close`, silent failure, second Esc as a no-op, and the mid-spawn case. The relay module's own tests are in `test/children/interrupt.test.ts`.

Commits `7e794b6` then the spec-alignment rework `e65d46e`; merges `f79a8f4`, `491b91e`.

## Comments

### 2026-11-13

The operator reversed the leave-open rule after this ticket was resolved, so the relay now closes as
well as stops.

Superseded: the acceptance line "No `pane close` and no process kill happens anywhere on this path",
and the same claim inside the test line that asserts the herdr commands received ("no `pane close`"),
together with the "Nothing is closed, nothing is killed" half of the `What to build` paragraph and
the "No `pane close` and no kill exists on the path" sentence in the `## Answer`. Those stay as the
record of what was first decided.

What holds instead: one Esc is still relayed into every live sub pane this registration holds, idle
children included, and the call still returns immediately without awaiting a relay; the panes of the
children whose wait ends this way are then closed. So a `pane close` is now expected on this path,
and no process is killed — the close is what ends the child. The escalation refusal stands: a second
Esc, or an Esc after the abort, is still a no-op and closes nothing further. Silent, best-effort
delivery, the mid-spawn abort, and the untouched Label lifecycle are unchanged.
