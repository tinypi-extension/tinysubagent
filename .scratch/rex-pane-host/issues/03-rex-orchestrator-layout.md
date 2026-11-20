# 03: Rex orchestrator-first layout

**What to build:** A two-child batch in Rex looks and behaves like a batch in herdr: the orchestrator keeps its three-fifths column, children share a right-hand column, and later children append below the bottom-most live sub-block. The layout uses Rex's own geometry and ratio resize API rather than fixed guesses.

**Blocked by:** 02: Rex single-child batch returns its report.

**Status:** ready-for-agent

- [ ] At column birth, the first child splits to the right so the orchestrator keeps three fifths of the width and the child column gets two fifths.
- [ ] A second child appends below the bottom-most live sub-block, and the child column boundaries are rebalanced through Rex's ratio-based pane resize API.
- [ ] Geometry comes from Rex session inspection as normalized rects, and resize calls identify adjacent panes by full block IDs with the correct direction and ratio.
- [ ] A boundary the operator has dragged is preserved on later spawns, matching herdr's layout intent.
- [ ] A failed layout read or resize is a best-effort warning; the child block stays open and usable and the batch still reports.
- [ ] Fake-`rex` CLI tests cover birth ratio, append position, rebalance calls, drift preservation and failure tolerance; herdr layout tests remain unchanged.
