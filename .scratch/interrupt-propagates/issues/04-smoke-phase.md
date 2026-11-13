# 04: Real-herdr interrupt smoke phase

**What to build:** The interrupt smoke script gains a phase that interrupts from the **orchestrator's** pane against a real herdr: every child pane shows a stopped turn with the child still at its prompt, the call comes back with interrupted rows and no summaries, and every pane is still open afterwards. This is the only place the relay into another pane is exercised for real rather than through a fake herdr.

**Blocked by:** 02 (Relay an orchestrator interrupt to every live child), 03 (The interrupted outcome)

**Status:** ready-for-agent

- [ ] The smoke phase interrupts from the orchestrator's pane and observes every child turn stopped.
- [ ] Every child stays alive at its prompt and every pane remains open; no pane is closed.
- [ ] The call returns interrupted rows with no summaries and no error status.
- [ ] The phase fails loudly if a child is left running a turn, if a pane closed, or if a row is not interrupted.
- [ ] The existing phases of the interrupt smoke script still pass.
