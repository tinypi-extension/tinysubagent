# 05: Interrupt stops the batch by killing children

**What to build:** With no panes to close, an operator interrupt stops the whole batch the only way it can: each child's process group is terminated, then killed after a short grace. The outcome is interrupted with no summary, so half a report is never read as a report — and nothing survives the call as an orphan.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] An interrupt in the orchestrator's turn reaches every live plain-terminal child and ends the batch at once, without waiting for the reminder budget.
- [ ] Each child's process group is terminated, not just the direct child, so a child's own tool subprocesses do not survive the batch.
- [ ] A child that ignores the termination signal is killed after a short grace so the call cannot hang.
- [ ] Every child stopped this way reports interrupted with no summary.
- [ ] No child process, and no descendant of one, is left running once the call returns.
- [ ] A session shutting down under a wait ends the wait the same way and leaves nothing running.
- [ ] A pane-host interrupt still relays one Esc into every live sub pane and still closes the panes it stopped, exactly as before.
