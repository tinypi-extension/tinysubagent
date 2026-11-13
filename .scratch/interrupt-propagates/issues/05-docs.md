# 05: Record the reversal in the docs

**What to build:** A new ADR records that an interrupt propagates to the children, the trade-offs it accepts, and what it refuses to do; ADR 0001's consequence sentence is amended to point at it. The glossary gains **Interrupted** as an outcome beside **Cancelled**, and the relayed sense of **Interrupt**. The README states that Esc stops the whole batch rather than only the wait.

**Blocked by:** 03 (The interrupted outcome)

**Status:** ready-for-agent

- [ ] The new ADR states the propagation decision, the immediate return, the blunt batch-wide scope, the silent best-effort relay, and the refusal to close panes or cascade.
- [ ] The new ADR names the trade-off given up: an operator can no longer stop only the orchestrator while the children run on.
- [ ] ADR 0001's consequence sentence is amended to point at the new ADR, keeping its no-closing half intact.
- [ ] The glossary defines **Interrupted** as an Outcome beside **Cancelled**, and extends **Interrupt** to cover an operator's Esc relayed to a child by the extension.
- [ ] The glossary keeps implementation detail out: no file names, no command names.
- [ ] The README states that Esc in the orchestrator's pane stops every live child and closes nothing.
