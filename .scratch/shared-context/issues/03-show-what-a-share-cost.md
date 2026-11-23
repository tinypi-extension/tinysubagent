# 03: Show what a share cost

**What to build:** Every child whose context was shared reports its size in the acknowledgment row and
in the result metadata — entry count and rough token count, e.g. `shared 42 entries · ~18k tokens` — so
a human can see that a share was expensive without opening the child's session file.

There is no cap. The number is the whole safeguard: the orchestrator chose full fidelity, and this is
what makes the choice visible.

**Blocked by:** 01 (a subagent can be given the orchestrator's context)

**Status:** ready-for-agent

- [ ] A shared child's acknowledgment row states the entry count and the rough token count of the fork
- [ ] The same figures appear in the result metadata for that child, not only in the TUI row
- [ ] A child spawned without a share shows no such line
- [ ] The figures describe what was written to the child's session file, excluding the dropped `system` entries
