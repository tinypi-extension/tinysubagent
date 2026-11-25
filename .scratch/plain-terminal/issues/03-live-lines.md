# 03: Live lines for a running batch

**What to build:** In a plain terminal the wait is no longer a silent freeze. Up to four live lines are drawn, one per child in the batch, each naming the child's role, label and elapsed time and showing the last line of the text it is streaming. They are the only view of a child there is, and they are replaced by the report the moment the call returns.

**Blocked by:** 02.

**Status:** resolved

- [x] A batch of four children draws four lines; a batch of one draws one; a batch of none draws nothing.
- [x] A line shows the child's role, label, profile and elapsed time from the moment it is spawned, so the spawn is acknowledged even though a wait follows.
- [x] A line shows the last line of that child's streamed text, truncated to the available width, and updates as the child writes.
- [x] A line keeps only its last line: no scrolling region, no wrapping block, no spinner.
- [x] Redraws are coalesced on a short fixed cadence off the draining reader, never per delta and never inside the reader, so rendering cannot stall a child.
- [x] The live lines are cleared when the batch result arrives and are not reproduced in it.
- [x] Pane-host batches draw no live lines; their pane is the view.

## Resolution

Landed on `plain-terminal`: `0b778b1` (merge 2f1d765). Up to four live lines, one per child, coalesced on a 250ms cadence off the draining reader, last streamed line truncated to width, ack-prefixed and cleared when the result lands. `onUpdate` stops being discarded; pane batches still draw none.
