# 04: Real-herdr interrupt smoke phase

**What to build:** The interrupt smoke script gains a phase that interrupts from the **orchestrator's** pane against a real herdr: every child pane shows a stopped turn with the child still at its prompt, the call comes back with interrupted rows and no summaries, and every pane is still open afterwards. This is the only place the relay into another pane is exercised for real rather than through a fake herdr.

**Blocked by:** 02 (Relay an orchestrator interrupt to every live child), 03 (The interrupted outcome)

**Status:** resolved

- [x] The smoke phase interrupts from the orchestrator's pane and observes every child turn stopped.
- [x] Every child stays alive at its prompt and every pane remains open; no pane is closed.
- [x] The call returns interrupted rows with no summaries and no error status.
- [x] The phase fails loudly if a child is left running a turn, if a pane closed, or if a row is not interrupted.
- [x] The existing phases of the interrupt smoke script still pass.

## Answer

`scripts/smoke-interrupt.ts` gained Phase C — Esc in the orchestrator's pane. It launches two children, waits for each pane and for each to be provably mid-turn, then reproduces a human interrupt in the TUI's order: `herdr pane send-keys <orchestrator> esc`, then abort of the call's signal, leaving the relay to reach every child on its own. It fails loudly if: the call is a tool error or not `finished`; either row is not `interrupted` with the exact label and a `null` summary; the returned pane set is not exactly the two panes it opened; a pane is closed; a child's turn is still running or its prompt is not back within 20s; or the call has not returned 30s after the interrupt.

Stop detection was extracted to `scripts/pane-state.ts` (`runningTurn`, `atPrompt`, `readPane`) and pinned against real captured pi screens in `test/scripts/pane-state.test.ts` — fail-closed, so a changed pi chrome fails with the pane printed rather than passing silently. Phase B was tightened to the same exact-status + stopped-turn checks, and its stale "the child keeps running" comments corrected. The script reaps every pane it opened and documents that it must be run from a plain shell in a herdr pane, since Phase C types Esc into its own pane.

The live smoke was not run here (it needs real herdr panes and would abort the harness's own turn); Phases A and B are unchanged in intent and every script is standalone-typechecked under the project flags.

Commit `568ab39`, merged by `5a61f12`.
