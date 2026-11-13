# 03: The interrupted outcome

**What to build:** A wait ended by an interrupt is reported as **interrupted**, distinct from **cancelled**, carrying no summary even when the child's Session record holds partial assistant text. `cancelled` keeps only its vanished-pane meaning. The result text tells the orchestrator the batch was interrupted and the panes were left open, is not a tool error, and the TUI renders an interrupted child without claiming a closed pane or a Report.

**Blocked by:** 02 (Relay an orchestrator interrupt to every live child)

**Status:** ready-for-agent

- [ ] An aborted wait yields the new `interrupted` outcome, and `cancelled` is reachable only when a pane vanished.
- [ ] An interrupted child carries no summary, even with partial assistant text in its Session record.
- [ ] An interrupted batch is not a tool error.
- [ ] The result text states that the batch was interrupted and the panes were left open.
- [ ] The rendered line for an interrupted child claims neither a closed pane nor a Report.
- [ ] Reports, exits, settles, refusals, and vanished panes keep their current outcomes and rendering.
- [ ] Tests cover the classification at the watcher's existing injected-probe seam and the wording at the existing result and render tests.
