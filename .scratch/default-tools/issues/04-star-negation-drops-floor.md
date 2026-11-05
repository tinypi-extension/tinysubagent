# 04: `-*` drops the floor

**What to build:** A role can opt out of the floor entirely, so a narrow role stays narrow when someone later widens `defaultTools`. `-*` in a role's `tools` means "do not inherit the floor" and composes left-to-right with the rest of the list, so `-*, read, grep` yields exactly `read` and `grep`. It is not a negation matching every name: it raises no unmatched warning, and it is a silent no-op when the floor is already empty.

**Blocked by:** 03

**Status:** ready-for-agent

- [x] A role listing `-*, read, grep` on a wide floor launches with exactly `read`, `grep`, and the report tool.
- [x] A role listing `-*` alone on a non-empty floor launches with only the report tool.
- [x] `-*` on an empty floor is a no-op that raises no warning.
- [x] `-*` raises no unmatched-pattern warning.
- [x] A role listing `-*` plus a positive glob still expands that glob against the registry.
- [x] `npm test` and `npm run typecheck` pass.
