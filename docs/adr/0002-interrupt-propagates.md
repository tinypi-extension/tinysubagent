# An interrupt reaches the children, not only the wait

Status: accepted

The orchestrator's turn can be interrupted while a blocking batch call is waiting on its children.
That used to end nothing but the wait: the call gave up silently, and every child ran on, spending
model calls against work the operator had just abandoned. To stop the work at all, the operator had
to visit each sub pane and interrupt it there too, once per child, in a hurry and in the wrong pane
order. An interrupt means *stop this*, not *stop watching this*, and the batch is the thing an
operator wants stopped.

So one interrupt in the orchestrator's pane is now relayed into every live sub pane this registration
holds — this batch's children and any earlier call's that are still live — one keystroke per pane,
each child's turn stopping where it is. The call still returns at once: the wait ends when the
interrupt is relayed, not when the children come to rest, so nothing waits on a stopped child to
confirm that it stopped. A child whose wait ended this way is reported as `interrupted`, distinct from
`cancelled` (a pane that vanished) and carrying no summary — half a report read as a report is worse
than none.

The scope is deliberately blunt and batch-wide. Every pane in the set is relayed to, idle children
included: a child's turn state is only visible once it settles, probing it would cost a round trip on
the path that has to return at once, and a pane that opened during the interrupt would still need its
own keystroke. A keystroke arriving at an idle prompt is harmless; a missed one is not. What the set
never includes is another orchestrator's panes — the scope is what this registration opened.

Relaying is silent and best effort. Sending is not awaited and every failure is swallowed, so a pane
that is already gone, or a relay that was refused, produces no warning, no error, and no change to the
returned result; one pane failing never stops the fan-out to the rest. Nor is an interrupt escalated:
it is one keystroke per interrupt, never a second to insist. It closes no pane, kills no child, does
not cascade into grandchildren (a subagent cannot spawn subagents, so there is no tree to walk), and
salvages no partial text from a stopped turn. The trade-off we give up is real: an operator can no
longer stop only the orchestrator and let the children run on. Interrupting the call now means
interrupting the work.

Consequences: an interrupted child stays alive at its prompt with its pane open and its context
intact, so the cheapest recovery is to read what it reached and redirect it by hand — the worst case
is a child that has to be re-prompted. Only the abort path changes: a report, an exit, a settle, a
refusal, and a vanished pane end a wait exactly as they did before, and the other consequence of
[ADR 0001](0001-blocking-tool-result.md) — that nothing here closes a pane — is kept, not reversed.
One ending the result does not tell apart: a session shutting down while a batch waits ends every wait
the same way — resolved `interrupted`, with no keystroke relayed — so the rows read as an interrupt even
though nothing was pressed.
