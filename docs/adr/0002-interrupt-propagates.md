# An interrupt stops the children and closes their panes

Status: accepted

The orchestrator's turn can be interrupted while a blocking batch call is waiting on its children.
That used to end nothing but the wait: the call gave up silently, and every child ran on, spending
model calls against work the operator had just abandoned. To stop the work at all, the operator had
to visit each sub pane and interrupt it there too, once per child, in a hurry and in the wrong pane
order. An interrupt means *stop this*, not *stop watching this*, and the batch is the thing an
operator wants stopped.

So one interrupt in the orchestrator's pane is now relayed into every live sub pane this registration
holds — this batch's children and any earlier call's that are still live — one keystroke per pane,
each child's turn stopping where it is, and the panes of the children whose wait ended this way are
then closed. The call still returns at once: the wait ends when the interrupt is relayed, not when the
children come to rest. Closing is what lets it return that early — nothing is left running behind the
result, so nothing has to be waited on to confirm that it stopped. A child whose wait ended this way is
reported as `interrupted`, distinct from `cancelled` (a pane that vanished) and carrying no summary —
half a report read as a report is worse than none. The row also says which of the two ways it ended:
the pane was closed, or it was left open because the session was going away rather than the work being
abandoned.

The scope is deliberately blunt and batch-wide. Every pane in the set is relayed to, idle children
included: a child's turn state is only visible once it settles, probing it would cost a round trip on
the path that has to return at once, and a pane that opened during the interrupt would still need its
own keystroke. A keystroke arriving at an idle prompt is harmless; a missed one is not. What the set
never includes is another orchestrator's panes — the scope is what this registration opened.

Relaying is silent and best effort. Sending is not awaited and every failure is swallowed, so a pane
that is already gone, or a relay that was refused, produces no warning, no error, and no change to the
returned result; one pane failing never stops the fan-out to the rest. Nor is an interrupt escalated:
it is one keystroke per interrupt, never a second to insist. It does not cascade into grandchildren (a
subagent cannot spawn subagents, so there is no tree to walk), and it salvages no partial text from a
stopped turn. Two trade-offs are accepted. An operator can no longer stop only the orchestrator and
let the children run on: interrupting the call now means interrupting the work. And the interrupted
child's pane is gone, so it can no longer be read or redirected afterwards; the cheapest recovery is
to re-run the task.

Consequences: only the abort path changes. A report, an exit, a settle, a refusal, and a vanished pane
end a wait exactly as they did before, closing a pane or not just as they always did. Of the two halves
of [ADR 0001](0001-blocking-tool-result.md)'s consequence, the half that still holds is that nothing
here closes a pane as a side effect: the only pane this decision closes is one whose child it has just
stopped, and a relay that cannot be delivered, or a second interrupt after the first, leaves every
remaining pane exactly as it found it. The ending the result does tell apart is the shutdown: a session
ending while a batch waits ends every wait the same way — resolved `interrupted`, with no keystroke
relayed — but its panes are left open, because the session is going away rather than the work being
abandoned. So a later reader can tell a batch the operator stopped from one the session dropped, which
the row states plainly instead of leaving it to be inferred.
