# 02: A child as a process — delegation works in a plain terminal

**What to build:** In a terminal with no pane host, the subagent tool registers and a batch of children actually runs: each child is launched as its own headless process with piped stdio, the call blocks, and every child's report comes back in the one tool result. This is the tracer bullet — the first end-to-end path through a mode that has no pane, and the slice the rest of the feature hangs off. A child that reports comes back with its report; a child that exits is learned from its exit code, so a batch can never hang on a process that has already died.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] With no pane host detected, the tool registers and a batch of children runs; nothing about detection changes for herdr or Rex, which still win when present.
- [ ] A detected-but-unready pane host keeps its existing readiness problem and its one-step fix; it never degrades into a headless run.
- [ ] A plain-terminal child is started with no pty and piped stdio, in pi's JSON event mode chosen explicitly in the argv rather than as a side effect of a non-tty, and behaves identically when the orchestrator's own stdio happens to be a tty.
- [ ] A plain-terminal child keeps the same wrapper, environment, direnv/launch-prefix handling, session file, tool list, brief and role as a pane-host child; only the supervision differs.
- [ ] The child's stdout is read continuously and never synchronously, and a child does not stall when its output outruns the reader.
- [ ] A wait ends on a report or on process exit, whichever comes first.
- [ ] Exit zero with no report is the existing content-free completion: no summary, and no process left behind.
- [ ] Exit non-zero with no report is a failure carrying the exit code.
- [ ] A report that declares failure is reported as a failure on the same footing as a non-zero exit.
- [ ] The reminder for an unreported turn end still works in a non-interactive run, with the same budget and the same content-free completion after it.
- [ ] The registration test that asserts the tool registers nothing outside a pane host is replaced by tests for: registers under a pane host, registers in a plain terminal, and prefers the pane host when one is detected.
- [ ] Every pane-host behaviour asserted today still passes unchanged.
