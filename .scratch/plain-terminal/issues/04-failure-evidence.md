# 04: Failure evidence reaches the report

**What to build:** What a human used to read off a child's pane now travels in the report. A failed plain-terminal child carries the last lines of its stderr and its exit code; a child pi refused to start carries the remedy that "the pane is still open" used to imply; and the pane-only affordances that have nowhere to live are dropped rather than faked.

**Blocked by:** 03.

**Status:** resolved

- [x] A failed child's report carries the tail of its stderr — a bounded recent window, not the whole stream — so the cause reaches the orchestrator instead of an exit code alone.
- [x] The stderr tail appears only for a child that failed; a successful child's report is unchanged.
- [x] A child pi never started is still classified as never started, and its report carries an actionable remedy instead of pointing at a pane that was left open.
- [x] Hold-open is not attempted where there is no tty: a crash does not wait for a keypress that can never arrive.
- [x] The cancelled outcome is unreachable in a plain terminal; a dead process is learned from its exit code. Pane hosts keep reporting cancelled when a pane vanishes.
- [x] No part of a vanished pane is scraped for a summary in a plain terminal.
- [x] Pane-host failure evidence — hold-open, cancelled, partial-text scraping — behaves exactly as before.

## Resolution

Landed on `plain-terminal`: `95cf1c6` (merge 6246fff). A failed child carries a 20-line stderr ring in its report (`outcome.stderr` → `ResultDetail.stderr`), bounded and attached only to failures; a pane-less never-started child gets an actionable remedy instead of "inspect its pane"; `cancelled` is unreachable without a pane (a dead process is learned from its exit code) and untouched under a pane host.
