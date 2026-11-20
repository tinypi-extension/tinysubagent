# 03: Rex orchestrator-first layout

**What to build:** A two-child batch in Rex looks and behaves like a batch in herdr: the orchestrator keeps its three-fifths column, children share a right-hand column, and later children append below the bottom-most live sub-block. The layout uses Rex's own geometry and ratio resize API rather than fixed guesses.

**Blocked by:** 02: Rex single-child batch returns its report.

**Status:** resolved

- [x] At column birth, the first child splits to the right so the orchestrator keeps three fifths of the width and the child column gets two fifths.
- [x] A second child appends below the bottom-most live sub-block, and the child column boundaries are rebalanced through Rex's ratio-based pane resize API.
- [x] Geometry comes from Rex session inspection as normalized rects, and resize calls identify adjacent panes by full block IDs with the correct direction and ratio.
- [x] A boundary the operator has dragged is preserved on later spawns, matching herdr's layout intent.
- [x] A failed layout read or resize is a best-effort warning; the child block stays open and usable and the batch still reports.
- [x] Fake-`rex` CLI tests cover birth ratio, append position, rebalance calls, drift preservation and failure tolerance; herdr layout tests remain unchanged.

## Comments

- Implemented across `a5d56c8`..`a8bb2c7`: Rex reads normalized rects from session inspection, the shared planner chooses birth/append placement, and `session.resize_pane` adjusts the matched split ratio between full block IDs. Operator-dragged borders survive later spawns; failed reads and resizes stay best effort. Fake-`rex` tests cover birth, append, rebalance, drift and failures, with herdr unchanged. Integration tip `15ec3de` merged; its only conflict was in `src/pane-host/rex.ts`, resolved by keeping both the layout adapter and the ticket 04 interrupt relay. `npm test` 557 pass, `npm run typecheck` clean.
