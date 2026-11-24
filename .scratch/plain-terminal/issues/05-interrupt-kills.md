# 05: Interrupt stops the batch by killing children

**What to build:** With no panes to close, an operator interrupt stops the whole batch the only way it can: each child's process group is terminated, then killed after a short grace. The outcome is interrupted with no summary, so half a report is never read as a report — and nothing survives the call as an orphan.

**Blocked by:** 04.

**Status:** resolved

- [x] An interrupt in the orchestrator's turn reaches every live plain-terminal child and ends the batch at once, without waiting for the reminder budget.
- [x] Each child's process group is terminated, not just the direct child, so a child's own tool subprocesses do not survive the batch.
- [x] A child that ignores the termination signal is killed after a short grace so the call cannot hang.
- [x] Every child stopped this way reports interrupted with no summary.
- [x] No child process, and no descendant of one, is left running once the call returns.
- [x] A session shutting down under a wait ends the wait the same way and leaves nothing running.
- [x] A pane-host interrupt still relays one Esc into every live sub pane and still closes the panes it stopped, exactly as before.

## Resolution

Landed on `plain-terminal`: `faff9b0` (merge 50a5c1b). `stop` on the plain kind signals the child's process group — SIGTERM, SIGKILL after `INTERRUPT_GRACE_MS = 5_000` (injectable, tests use 120ms), bounded settle after the kill. Session shutdown aborts through the same path. Real detached children assert four pids are gone afterwards; the pane interrupt path is byte-for-byte unchanged.
