# 07: Document both supervision modes

**What to build:** The project's own documentation stops treating a pane host as a prerequisite. A reader in a plain terminal learns that delegation works, what they get (live lines, one report per child), and what they give up (no steering a child, no pane to read a crash from — the failure evidence is in the report, and stopping the batch kills it).

**Blocked by:** 03, 04, 05, 06.

**Status:** resolved

- [x] No entry point in the documentation presents herdr or Rex as a requirement for using the tool; they are presented as the richer option where available.
- [x] The plain-terminal experience is described: children run as headless processes, live lines are the only view, and the call still returns one report per child.
- [x] The things a plain terminal cannot do are stated plainly: a child cannot be watched in a pane, steered, or read off a scrollback, and an interrupt kills the batch rather than closing panes.
- [x] The failure evidence that replaces a pane is documented: exit code and stderr tail in the report, and an actionable remedy for a child that never started.
- [x] The two recorded decisions are linked from where a reader would look for the reasoning.
- [x] Nothing in the documentation describes behaviour that no ticket above delivers.

## Resolution

Landed on `plain-terminal`: `628c559` (merge 3b7fbcd). `README.md` now presents herdr/Rex as the richer option rather than a prerequisite, describes headless plain-terminal runs, live-line-only visibility, per-child reports, the kill-instead-of-close interrupt and the report-carried failure evidence, and links both ADRs.
