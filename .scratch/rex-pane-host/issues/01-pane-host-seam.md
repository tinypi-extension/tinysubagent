# 01: Pane-host seam with herdr passthrough

**What to build:** All pane-host work goes through one host-neutral seam before Rex is added. The herdr tool keeps registering, spawning, reporting, interrupting and closing exactly as it does today. This makes the change easy: the seam is verifiable on its own, and the herdr side stays green while the Rex adapters are built on it.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [ ] In herdr, tool registration, spawn, reports, Esc interrupt and close behavior are unchanged.
- [ ] All existing herdr tests pass without modification.
- [ ] Host-neutral operations cover host detection, capability readiness, child spawn/rename/close, liveness, layout read/resize and interrupt relay, backed by the existing herdr CLI.
- [ ] Tests exercise those operations through a fake CLI at the command boundary, rather than by calling internal helpers.
- [ ] No call site outside the seam inspects herdr-specific environment variables or CLI details.
- [ ] No Rex registration, Rex commands or Rex-specific behavior is introduced by this ticket.

## Comments

- Implemented in `de2d67b`: host-neutral `PaneHost` seam with herdr passthrough, fake-CLI command-boundary tests, and production call sites rerouted through the seam. Integration tip `6df3b6a` merged (already up to date); `npm test` 538 pass / 0 fail and `npm run typecheck` clean after merge.
