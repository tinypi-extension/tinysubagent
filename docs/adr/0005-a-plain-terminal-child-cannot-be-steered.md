# A plain-terminal child cannot be steered, so its evidence moves into the report

With no pane there is no screen to watch, no prompt to type at, and no scrollback to read a crash
from. We accepted that loss rather than faking it: a plain-terminal child runs headless with piped
stdio, its progress is synthesised into live lines off its own JSON event stream, an operator
interrupt kills its process group instead of closing a pane, and everything a human used to learn by
looking at the pane — the exit code, the last 20 lines of stderr, the remedy for a child pi refused
to start — is carried in the report instead.

The alternatives were a pty nobody reads (a TUI with no viewer, whose extensions cannot prompt
anyway) and a silent downgrade where a failure returns "exit 1" and nothing else. The first is a
worse version of a pane; the second strands the orchestrator on exactly the case the panes used to
cover.

Consequences: `cancelled` is unreachable here — it says the pane went unexpectedly, and a process
that dies is learned from its exit code — so `failed` gains a second route (a non-zero exit) with
the same meaning. Hold-open is dropped, since a tty-less wait for a keypress returns immediately.
Live lines are transient and the report is the record. The trade-off is deliberate and one-way: a
human cannot redirect a plain-terminal child mid-run, and this change adds no channel to try.
