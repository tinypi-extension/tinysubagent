# 05: Record the reversal in the docs

**What to build:** A new ADR records that an interrupt propagates to the children, the trade-offs it accepts, and what it refuses to do; ADR 0001's consequence sentence is amended to point at it. The glossary gains **Interrupted** as an outcome beside **Cancelled**, and the relayed sense of **Interrupt**. The README states that Esc stops the whole batch rather than only the wait.

**Blocked by:** 03 (The interrupted outcome)

**Status:** resolved

- [x] The new ADR states the propagation decision, the immediate return, the blunt batch-wide scope, the silent best-effort relay, and the refusal to close panes or cascade.
- [x] The new ADR names the trade-off given up: an operator can no longer stop only the orchestrator while the children run on.
- [x] ADR 0001's consequence sentence is amended to point at the new ADR, keeping its no-closing half intact.
- [x] The glossary defines **Interrupted** as an Outcome beside **Cancelled**, and extends **Interrupt** to cover an operator's Esc relayed to a child by the extension.
- [x] The glossary keeps implementation detail out: no file names, no command names.
- [x] The README states that Esc in the orchestrator's pane stops every live child and closes nothing.

## Answer

New `docs/adr/0002-interrupt-propagates.md` records the propagation decision, the immediate return, the blunt batch-wide scope, the silent best-effort relay, the refusals (no closing, no killing, no second-Esc escalation, no grandchild cascade, no partial-text salvage), the trade-off given up — an operator can no longer stop only the orchestrator while children run on — and the one ending the result does not distinguish: a session shutting down under a wait also resolves `interrupted`, with no keystroke relayed.

`docs/adr/0001-blocking-tool-result.md`'s consequence sentence now points at ADR 0002 while keeping its no-closing half. `GLOSSARY.md` defines **Interrupted** as an outcome beside **Cancelled** (and adds the **Cancelled** entry the outcome list implied), extends **Interrupt** to the batch-wide relay, and adds no file, command, or key names. `README.md` states that Esc in the orchestrator's pane is relayed to every live sub pane, that each child stops where it is and is reported `interrupted`, and that nothing is closed. The model-facing tool description was corrected in the same spirit.

Commit `9b8d768`, merged by `e385e8f`; the shutdown caveat and the softened pane claim came with `05ec910` / `eb94acd` / `f947660`.
