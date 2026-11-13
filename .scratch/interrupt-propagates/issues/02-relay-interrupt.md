# 02: Relay an orchestrator interrupt to every live child

**What to build:** Interrupting the orchestrator's turn sends one Esc into every pane this registration holds — the Batch in flight and any earlier child still live, idle children included — and then returns the call at once. Nothing is closed, nothing is killed, and the relay never waits for an answer. A relay that cannot be delivered is silent: no warning, no failure, no close, and the rest of the fan-out still happens. A second Esc changes nothing. An interrupt that lands while Spawns are still opening stops the remaining requests from launching, keeping the Labels of children that started and releasing those of requests that never did.

**Blocked by:** 01 (Expose the registration's Sub panes as ids)

**Status:** ready-for-agent

- [ ] Interrupting the call's turn relays one Esc into each of the registration's Live sub panes before the waits end, including children of earlier calls.
- [ ] Idle children are relayed to as well: mid-turn state is not detected, and this bluntness is recorded in the code's own account of the feature.
- [ ] The call returns as soon as the relay is issued; no relay is awaited.
- [ ] No `pane close` and no process kill happens anywhere on this path.
- [ ] A relay that fails — a pane already gone, a herdr error — produces no warning, no failure and no change to the result, and does not stop the other relays.
- [ ] A second Esc, or an Esc once the call has already aborted, is a no-op and never escalates to closing panes.
- [ ] Every abort of the call's signal relays the interrupt, whatever aborted it.
- [ ] An abort mid-spawn leaves the remaining requests unlaunched; started children keep their Labels, unlaunched requests release theirs.
- [ ] Tests at the tool call's existing execution seam assert the herdr commands actually received: one `send-keys … esc` per live child, none for a dropped pane, and no `pane close`.
- [ ] Tests cover the silent-failure and second-Esc cases, and the mid-spawn case, at that same seam.
