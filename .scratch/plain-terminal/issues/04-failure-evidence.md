# 04: Failure evidence reaches the report

**What to build:** What a human used to read off a child's pane now travels in the report. A failed plain-terminal child carries the last lines of its stderr and its exit code; a child pi refused to start carries the remedy that "the pane is still open" used to imply; and the pane-only affordances that have nowhere to live are dropped rather than faked.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] A failed child's report carries the tail of its stderr — a bounded recent window, not the whole stream — so the cause reaches the orchestrator instead of an exit code alone.
- [ ] The stderr tail appears only for a child that failed; a successful child's report is unchanged.
- [ ] A child pi never started is still classified as never started, and its report carries an actionable remedy instead of pointing at a pane that was left open.
- [ ] Hold-open is not attempted where there is no tty: a crash does not wait for a keypress that can never arrive.
- [ ] The cancelled outcome is unreachable in a plain terminal; a dead process is learned from its exit code. Pane hosts keep reporting cancelled when a pane vanishes.
- [ ] No part of a vanished pane is scraped for a summary in a plain terminal.
- [ ] Pane-host failure evidence — hold-open, cancelled, partial-text scraping — behaves exactly as before.
