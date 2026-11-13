# Subagent results arrive as the tool result, not as a steer message

The subagent tool used to return an acknowledgment as soon as the panes were open and deliver each
batch's report later, as a steer message injected into the orchestrator's session. We made the call
block instead: `execute` waits for the whole batch and returns the reports as its result.

Two reasons. The orchestrator had nothing useful to do in the gap — the tool text told it to end its
turn and wait — so the injected message only re-entered a session that was idle by instruction. And a
report arriving as a steer is indistinguishable from a human redirecting the session: it can land
mid-turn, in an order unrelated to the calls that asked for it. A tool result cannot.

The trade-off is real and deliberate: a blocking call gives up interleaving. An orchestrator can no
longer start a batch, do local work, and collect the report afterwards, and a second batch cannot
start until the first returns. We accepted that because the herdr panes are the live view of a running
child, and the reports are the whole reason the call exists.

Consequences: the wait now has to end without a human present, so an unreported turn end becomes
terminal once the child's report reminders are spent (a content-free completion, no summary, pane left
open as the only evidence), and a child pi refused before any run is failed as `never-started` after a
90s grace. Interrupting the orchestrator's turn ends the wait at once, and it never closes a child's
pane — the interrupt is relayed into every live child instead, as
[ADR 0002](0002-interrupt-propagates.md) records. Only a child that reported, or whose pi exited, has
its pane closed here.
