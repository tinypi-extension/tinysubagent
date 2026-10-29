# 02: A floor never refuses or breaks a spawn

**What to build:** Setting a floor cannot block delegation. A `subagent` entry in `defaultTools` is dropped with a warning instead of tripping the nested-delegation guard that a role-level `subagent` entry still trips — ambient config the user wrote for its other names must not refuse every spawn in the project. An agy-profile spawn warns that the floor is ignored and starts anyway, while the existing refusal for a role that declares `tools` under agy is unchanged. A role naming `subagent` or `*` still refuses, and that refusal stays covered.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] A floor naming `subagent` produces a warning and a successful spawn, with `subagent` absent from the child's allowlist.
- [ ] A role naming `subagent` still refuses to spawn with the existing explanatory error.
- [ ] A role declaring `*` still refuses to spawn, because expansion includes `subagent`.
- [ ] An agy-profile spawn with a non-empty floor warns that the floor is ignored and launches.
- [ ] An agy-profile spawn for a role that declares `tools` still refuses, unchanged.
- [ ] `npm test` and `npm run typecheck` pass.
