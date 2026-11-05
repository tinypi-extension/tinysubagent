# 01: The floor reaches the child

**What to build:** A user can set a `defaultTools` array in a tinysubagent settings file and every child starts with exactly that list. The key is a plain list of tool names — no glob, no negation — and it layers by scope with the highest-precedence file that states it winning its whole array, while an absent key resolves to an empty array. A malformed key (not an array, a non-string entry, an entry containing `*` or starting with `-`) warns at startup and drops only the offending part. The role's own `tools` positives are added to the floor and its `*` globs still expand against the tool registry; the report tool is appended to every explicit allowlist. A role that declares no `tools` on an empty floor still launches with no allowlist at all, exactly as today.

This ticket lands the single pure tool-list resolver the later tickets build on: floor entries plus raw role entries plus the registry in, final names plus warnings plus "is there an allowlist at all" out.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] A settings file with `defaultTools` of plain names launches a role that declares no `tools` with exactly those names plus the report tool.
- [x] A project-scope `defaultTools` replaces a global one wholesale; entries are not unioned.
- [x] An absent `defaultTools` resolves to an empty array without a warning.
- [x] A non-array `defaultTools`, a non-string entry, and an entry containing `*` or starting with `-` each warn at startup in the established config-warning form, and the valid entries still apply.
- [x] A role's `tools` positives are added to the floor, and its `*` entries still expand against the registry.
- [x] A role with no `tools` frontmatter and an empty floor launches with no tool allowlist flag, byte-identical to today.
- [x] The resolver is a single pure function covered by table-driven tests for every rule above, with no filesystem or pane involved.
- [x] `npm test` and `npm run typecheck` pass, and the existing suites pass unmodified.
