# tinysubagent — confirmed intent

Captured before any code existed, via interview. This is the contract. If a change
contradicts a line here, that line must be edited first, deliberately.

## What it is

A clean-room pi extension that spawns **herdr-pane subagents** from markdown role
definitions, in single or parallel mode, each in a right-hand pane the user can type
into, and steers the result back to the orchestrator when the pane finishes.

## Why

`pi-herdr-subagents` works but is ~45KB across 10 modules. This is a spawn-only
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

- Clean-room pi-side code. The reference (`~/Project/pi-herdr-subagents-main`) is used
  only as the spec for herdr CLI mechanics and the herdr-plugin event flow.
- The **herdr plugin is reused as-is** — it stays a dependency.
- Config lives in a standalone `~/.pi/agent/tinysubagent.json` (or `.jsonc` for a file that
  can carry comments), untouched by `settings.json`.
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

The same file may be named `tinysubagent.jsonc`, in which case it may carry `//` and `/* */`
comments and trailing commas. When both names exist the `.jsonc` wins and the `.json` is
ignored silently — writing a `.jsonc` is all it takes to switch over. `PI_TINYSUBAGENT_CONFIG`
points at a specific file and beats both.

## Migration

`~/.pi/agent/extensions/subagent/` (pi-herdr-subagents) stays installed until
tinysubagent has proven itself in daily use. Both tools coexist during that window.
