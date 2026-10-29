# 03: `-name` negation in a role's `tools`

**What to build:** A role author can subtract a tool from the floor and from its own positives by prefixing the name with `-`. Deny wins order-independently, so `-write, write` and `write, -write` mean the same thing, and a negation beats a floor name. A negation that matches nothing warns like an unmatched positive pattern does. A list emptied by subtraction still spawns — with only the report tool on its allowlist and a warning in the acknowledgment — rather than launching with no allowlist, which would widen the child to everything. `-subagent_report` is ignored with a warning and the report tool is always appended, because the report is the hand-back contract rather than a capability.

**Blocked by:** 01

**Status:** ready-for-agent

- [x] A role listing `-write` removes `write` from a floor that contains it.
- [x] A role listing `-write, write` and one listing `write, -write` produce the same allowlist, excluding `write`.
- [x] A role listing a `-*`-free negative whose name matches no tool warns, and the rest of the list stands.
- [x] A floor and role list that cancel each other out launch with only the report tool and an acknowledgment warning naming the empty allowlist.
- [x] `-subagent_report` is ignored with a warning and the report tool is still on the allowlist.
- [x] Negation never reaches the child as a command-line flag; the child receives plain tool names.
- [x] `npm test` and `npm run typecheck` pass.
