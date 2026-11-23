# 03: Show what a share cost

**What to build:** Every child whose context was shared reports its size in the acknowledgment row and
in the result metadata — entry count and rough token count, e.g. `shared 42 entries · ~18k tokens` — so
a human can see that a share was expensive without opening the child's session file.

There is no cap. The number is the whole safeguard: the orchestrator chose full fidelity, and this is
what makes the choice visible.

**Blocked by:** 01 (a subagent can be given the orchestrator's context)

**Status:** resolved

- [x] A shared child's acknowledgment row states the entry count and the rough token count of the fork
- [x] The same figures appear in the result metadata for that child, not only in the TUI row
- [x] A child spawned without a share shows no such line
- [x] The figures describe what was written to the child's session file, excluding the dropped `system` entries

## Resolution

Landed on `integration/shared-context`: `478d495`, with the plumbing tidied by `34024af` so the figures are the fork's own (`cost`, `lines`) and describe what was actually written rather than what was projected into it.
