# tinysubagent — confirmed intent

Captured before any code existed, via interview. This is the contract. If a change
contradicts a line here, that line must be edited first, deliberately.

## What it is

A clean-room pi extension that spawns **herdr-pane subagents** from markdown role
definitions, in single or parallel mode, each in a right-hand pane the user can type
into, and steers the result back to the orchestrator when the pane finishes.

## Why

The reference implementation works but is ~45KB across 10 modules. This is a spawn-only
replacement that is small enough to read top-to-bottom and own.

## Success criteria

- Registered **only** when herdr is running. If herdr is absent the tool does not
  appear in the tool list at all. *(Explicitly chosen over register-and-error.)*
- Roles discovered from `~/.pi/agent/agents/*.md` and `<project>/.pi/agents/*.md`.
  On a name clash, the project definition wins.
- Tool description lists each role's `name` and `description`.
- The child may only call the tools named in that role's frontmatter `tools` list,
  plus the single injected reporting tool `subagent_report`, which is added to
  every allowlist so a role can always hand its result back. A role with no `tools`
  list still gets no allowlist at all.
- `profile` is compulsory when `enableProfiles` is true; absent from the schema when
  false. `"current"` is always a valid implicit profile.
- Single and parallel spawn.
- One steer message per child; the pane closes on its own completion.

## Parallel semantics

Spawn N panes, **wait for all of them**, then emit **one combined steer message**,
results labelled per task so the orchestrator can attribute output to the child that
produced it. Order is task order.

If a child dies without completing, emit the partial result once the last *survivor*
finishes, with the dead child marked `failed`. Never hang forever on N/N.

Interrupting a child is not completing it. A user who presses Esc in a child's pane is
there to redirect it, and that child stays in the batch with its pane open: no steer, no
`failed`. The batch is held until that child reports for real or its pane goes away.
(Distinct from the `interrupt` feature in *Out of scope*, which would be the orchestrator
reaching into a child's turn; nothing here does that.)

## Constraints

- Clean-room pi-side code. The third-party reference is used only as the spec for herdr
  CLI mechanics and the herdr-plugin event flow.
- The **herdr plugin is owned here** — `herdr-plugin/` ships with this repo (id
  `tinysubagent-panes`) and is linked once with `herdr plugin link`; it is no longer an
  external dependency.
- Config lives in a standalone `tinysubagent.json` (or `.jsonc` for a file that can carry
  comments), untouched by `settings.json`. The per-user file stays at `~/.pi/agent/`; a project
  may carry its own at `<project>/.pi/`.
- Aim for one readable `index.ts` plus small helpers, not a module tree.
- Children inherit the user's installed pi extensions, so MCP tools resolve in the
  child; the frontmatter `tools` allowlist still gates what the child may call.
- If a pane dies without signalling completion, v1 does nothing clever: pane stays
  open, no steer. No timeout, no auto-rescue.

## Out of scope

`resume` · `interrupt` · `list` · non-herdr fallback · aggregated-per-child ordering
tricks · hot config reload.

## Config shape

```json
{
  "enableProfiles": true,
  "profiles": {
    "light": { "model": "oc-openai/deepseek-flash", "thinking": "low" },
    "core":  { "model": "oc-openai/deepseek-flash", "thinking": "medium" },
    "pro":   { "model": "oc-openai/glm-5.3-flash", "thinking": "high" },
    "ultra": { "model": "oc-openai/deepseek-flash", "thinking": "high" }
  }
}
```

Missing file ⇒ same as `enableProfiles: false`.

A config is read from two scopes. **Global** is `<agentDir>/tinysubagent.json` or `.jsonc`,
where `<agentDir>` is `~/.pi/agent` (`$PI_CODING_AGENT_DIR` when set). **Project** is
`<project>/.pi/tinysubagent.json` or `.jsonc` — the project's `.pi/`, not `.pi/agent/`. The
`.jsonc` variant may carry `//` and `/* */` comments and trailing commas. Precedence, highest
first:

1. `$PI_TINYSUBAGENT_CONFIG` — the only file read; nothing layers under it.
2. `<project>/.pi/tinysubagent.jsonc`
3. `<project>/.pi/tinysubagent.json`
4. `<agentDir>/tinysubagent.jsonc`
5. `<agentDir>/tinysubagent.json`

Two rules, independent of each other. **Scope beats filename**: a project `.json` outranks a
global `.jsonc`. **Within one directory** `.jsonc` outranks `.json` and the sibling `.json` is
ignored silently — writing a `.jsonc` is all it takes to switch over.

The files layer, they do not replace. `profiles` merge by name with the higher scope winning
per name, so a project file adding one profile inherits every global profile and redefining one
replaces only that one. `enableProfiles` comes from the highest-precedence file that specifies
the key.

A project file that cannot be read or parsed is skipped with a warning naming it, and the
global config still applies — a repo file can never disable profiles that were already working.

Repos should commit `.pi/tinysubagent.jsonc`, which needs a `.gitignore` negation pair: a bare
`.pi/` ignore rule (very common — `.pi/` usually holds per-machine state) swallows the config
silently, as `git check-ignore` confirms. Git cannot re-include a file whose parent directory
is excluded, so `.pi/*` is required rather than `.pi/`:

```gitignore
.pi/*
!.pi/tinysubagent.jsonc
```

Accepted limitation: when `<project>/.pi/agent` exists, spawned children are launched with
`PI_CODING_AGENT_DIR` pointing at it, so a child's global scope is that directory rather than
`~/.pi/agent`. A subagent that itself delegates may therefore resolve a different merged
profile set than its parent. Nothing is forwarded.

## Migration

`~/.pi/agent/extensions/subagent/` (the third-party predecessor) stays installed until
tinysubagent has proven itself in daily use. Both tools coexist during that window, and
the bundled plugin is independent of it.
