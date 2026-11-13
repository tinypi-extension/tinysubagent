# 01: Expose the registration's Sub panes as ids

**What to build:** The registration's record of Live sub panes can hand back the panes it holds as a plain list of ids, without asking herdr for the tab's layout first. Pure prefactor: placement, sizing, `drop`, and the existing layout-checked enumeration behave exactly as they do today. It exists so the interrupt path can name every pane this registration holds with no subprocess and no new way to fail.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The Live sub panes tracker lists the ids it currently holds, in a stable order, with no herdr call.
- [ ] A pane id nobody placed is never listed; a dropped id stops being listed.
- [ ] Enumeration never mutates the tracked set and never throws.
- [ ] The existing layout-checked enumeration, placement, and sizing behaviour are unchanged.
- [ ] Tests cover an empty tracker, a placed pane, and a dropped pane, at the existing layout seam.
