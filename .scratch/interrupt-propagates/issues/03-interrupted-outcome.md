# 03: The interrupted outcome

**What to build:** A wait ended by an interrupt is reported as **interrupted**, distinct from **cancelled**, carrying no summary even when the child's Session record holds partial assistant text. `cancelled` keeps only its vanished-pane meaning. The result text tells the orchestrator the batch was interrupted and the panes were left open, is not a tool error, and the TUI renders an interrupted child without claiming a closed pane or a Report.

**Blocked by:** 02 (Relay an orchestrator interrupt to every live child)

**Status:** resolved

- [x] An aborted wait yields the new `interrupted` outcome, and `cancelled` is reachable only when a pane vanished.
- [x] An interrupted child carries no summary, even with partial assistant text in its Session record.
- [x] An interrupted batch is not a tool error.
- [x] The result text states that the batch was interrupted and the panes were left open.
- [x] The rendered line for an interrupted child claims neither a closed pane nor a Report.
- [x] Reports, exits, settles, refusals, and vanished panes keep their current outcomes and rendering.
- [x] Tests cover the classification at the watcher's existing injected-probe seam and the wording at the existing result and render tests.

## Answer

`SubagentOutcome` gained `{ kind: "interrupted" }` with no summary field, so "interrupted with a summary" is unrepresentable. `watcher.onAbort` resolves it without reading the final message; the vanished-pane path is now the only producer of `cancelled` and keeps its rendering. An interrupted batch is not a tool error. `statusLabel` renders `interrupted (pane left open)`, and the result text leads with a batch-level note: every child's pane was left open when all rows were interrupted, the interrupted children's panes when only some were (a completed child's pane is closed and is not claimed). Reports, exits, settles, refusals and vanished panes keep their outcomes and rendering.

Tests cover classification at the watcher's injected-probe seam (including partial assistant text still yielding no summary), the wording at the result and render tests, and the batch note for all-interrupted, mixed, and uninterrupted batches.

Commit `30a8674`, merged by `610455f`; the batch-level note arrived with the review fixes `05ec910` / `eb94acd`.
