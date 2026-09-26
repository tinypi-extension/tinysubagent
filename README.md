# tinysubagent

Minimal, herdr-native subagent spawning for [pi](https://pi.dev). Define roles as
markdown files and delegate to them — every subagent runs in a shared right-hand
[herdr](https://herdr.dev/) column beside the orchestrator, each with an isolated context
window, and reports back as a steer message.

- **Markdown roles** in `~/.pi/agent/agents/*.md` and `<project>/.pi/agents/*.md`.
- **Fire-and-forget** — the spawn returns immediately; results wake your session later.
- **Single or parallel** — one task, or up to 4 reporting back in one message. The
  orchestrator keeps 3/5 of the split; every live sub shares one right-hand column, stacked
  and equal in height.
- **Model profiles** — optional `light` / `core` / `pro`-style (or whatever you use) with `{ model, thinking }` pairs.
- **Per-child `env`** — hand a subagent static variables without changing the orchestrator's own environment.
- **Small enough to read** — one `index.ts` plus focused modules.

The tool is registered **only when pi runs inside herdr**. Outside herdr there is no pane
to split, so it is not offered at all.

## Requirements

| Requirement | Details |
| --- | --- |
| pi | The pi coding agent. |
| herdr | **0.8.2 or newer** (`herdr --version`). |
| herdr running | `herdr status server --json` reports `"running": true`. |
| `tinysubagent-panes` plugin | Ships in `herdr-plugin/`; pi offers to link it on the first session inside herdr. |
| pi started inside a herdr pane | Registered only when `HERDR_ENV=1`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` are set. |

## Install

```bash
pi install git:github.com/tinypi-extension/tinysubagent   # or git@github.com:...
pi install -l ...          # into project settings (.pi/settings.json)
pi -e ...                  # temporary, current run only
pi install ...@v0.1.0      # pin a tag: update --extensions keeps it on that tag
pi update --extensions     # update (reconciles git refs); pi list to inspect
```

Install **without a ref** so updates keep working. Pinned refs are checkout targets — to
upgrade, install the newer tag explicitly.

### Link the herdr plugin

The pane entrypoint ships with the package in `herdr-plugin/` (plugin id
`tinysubagent-panes`, entrypoint `subagent`). herdr stores the absolute path and copies
nothing.

You do not have to do this by hand: in an interactive or RPC session pi asks
*"Link the tinysubagent herdr plugin?"* before your first prompt and runs the link on
confirmation. Otherwise, or to link manually:

```bash
herdr plugin link /path/to/tinysubagent/herdr-plugin --enabled   # or: npm run link-plugin
herdr plugin list                                                # verify: enabled
herdr plugin enable tinysubagent-panes                           # if disabled
```

In print/JSON mode there is no dialog and nothing is linked — trigger the `subagent` tool
and the "not installed" error prints the exact path to link.

### Verify

`pi list` shows tinysubagent, `herdr plugin list` shows the plugin enabled, and a pi
restarted inside a herdr pane lists a `subagent` tool with your roles. Otherwise see
[Troubleshooting](#troubleshooting).

## Define a role

A role is a markdown file with YAML frontmatter; the body is the child's system prompt.

```markdown
---
name: scout
description: Fast codebase recon that returns compressed context for a handoff.
tools: read, grep, glob, codegraph_*
---

You explore a codebase and report findings for another agent to act on.

- Read the relevant files and follow the real call paths before concluding anything.
- Return a compressed brief: file paths, symbol names, and the flow between them.
- Do not propose a plan. Do not edit anything. Your output is the context itself.
```

Save as `~/.pi/agent/agents/scout.md` (everywhere) or `<project>/.pi/agents/scout.md`
(that project).

Load order: user roles (`<agentDir>/agents/*.md` — `~/.pi/agent/agents/`, or
`$PI_CODING_AGENT_DIR/agents/` when set), then project roles. On a name clash the
**project definition wins**. Files are read in name order.

| Field | Required | Notes |
| --- | --- | --- |
| `name` | No | Defaults to the filename. Used to select the role. |
| `description` | Recommended | Advertised in the tool description. Missing → warning, role still usable. |
| `tools` | No | Child allowlist: comma/whitespace-separated string or YAML list. `*` matches any run of characters (`codegraph_*`, `mcp__*`). |

Notes on `tools`:

- `subagent_report` (the child-side hand-back tool) is always added, so a role can return
  its result.
- Without `tools` the child gets **no allowlist** and inherits pi's normal tool set.
- A literal name is kept even if nothing matches, so a renamed tool warns instead of
  silently narrowing the allowlist; unmatched wildcards also warn on the spawn
  acknowledgment.
- **Nested delegation is unsupported.** Listing `subagent` fails the spawn with an
  explanation: a grandchild's result lands in the subagent's own session, and nothing
  carries it up to the orchestrator.

## Profiles

A profile is a `{ model, thinking }` pair a child is launched with, configured in
`~/.pi/agent/tinysubagent.jsonc`:

```jsonc
{
  "enableProfiles": true,
  "profiles": {
    "light": { "model": "<provider>/<small-model>",  "thinking": "low" },
    "core":  { "model": "<provider>/<default-model>", "thinking": "medium" },
    "pro":   { "model": "<provider>/<large-model>", "thinking": "high" }
  }
}
```

- `current` is built in, means "inherit this session", and **cannot be redefined** (a
  config that tries is ignored with a warning).
- A named profile is refused unless `enableProfiles` is literally `true`. When profiles are
  off the `profile` parameter is removed from the schema entirely.
- `model` and `thinking` are each optional and fall back to your session's value.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unknown values
  warn and are ignored.
- A missing config file is the default state, equivalent to `enableProfiles: false`.

### Config resolution

| Precedence | File |
| --- | --- |
| 1 | `$PI_TINYSUBAGENT_CONFIG` — the only file read |
| 2 | `<project>/.pi/tinysubagent.jsonc` |
| 3 | `<project>/.pi/tinysubagent.json` |
| 4 | `~/.pi/agent/tinysubagent.jsonc` |
| 5 | `~/.pi/agent/tinysubagent.json` |

- **Scope beats filename:** a project `.json` outranks a global `.jsonc`.
- **Within one directory** `.jsonc` wins and the sibling `.json` is silently ignored.
- Files **layer**: `profiles` merge by name and `env` merges per key, higher scope winning,
  so a project file can add one profile or one variable and inherit the rest.
  `enableProfiles` comes from the highest-precedence file specifying it.
- Both formats allow comments and trailing commas.
- An unreadable or unparseable file is skipped with a warning naming it, and the next
  scope applies.

To commit a project config under a bare `.pi/` gitignore rule you need a negation pair
(git cannot re-include a file inside an excluded directory):

```gitignore
.pi/*
!.pi/tinysubagent.jsonc
```
- Config with TUI via `/subagent-settings`
## Environment variables

`env` hands each subagent a static variable without changing the environment of the session
that spawned it — nothing is exported into the orchestrator:

```jsonc
{
  "env": {
    "PROJECT_NAME": "tinysubagent",
    "VERBOSE": "1"
  }
}
```

- **Values are strings, always.** A number, boolean, `null`, array or object is skipped with
  a warning rather than coerced. `{"DEBUG": false}` would otherwise export the string
  `"false"`, which every shell test reads as *true*; and a JSON number round-trips through
  IEEE754, so `1.0` becomes `"1"` and a long numeric id loses its last digits.
- **Keys must be shell identifiers** — `[A-Za-z_][A-Za-z0-9_]*`. `"a b"` is skipped with a
  warning, because `export a b=x` breaks the whole launch script, not just one variable.
- `"FOO": ""` exports `FOO` as set-but-empty. Omit the key to leave it unset.
- **Merged per key**, project over global, exactly like `profiles`; a
  `$PI_TINYSUBAGENT_CONFIG` override replaces both.
- **A collision goes to the launcher.** `PATH`, `PI_CODING_AGENT_DIR` and the
  `PI_TINYSUBAGENT_*` variables a child uses to report back are written after `env`, so a
  config value of the same name is overwritten.

A bad entry never blocks a spawn: the key is dropped, the warning joins the other config
warnings at session start, and the child launches with everything that was valid.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No `subagent` tool | pi is not inside herdr | Start pi from a herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`). |
| "herdr is not reachable from this pane" | herdr server stopped | `herdr status server --json`; restart herdr. |
| "herdr >= 0.8.2 is required" | Old herdr | Update herdr, then restart the herdr session. |
| Plugin "is not installed" / "is disabled" | Entrypoint never linked, or the offer was declined | Confirm the prompt, or run the `herdr plugin link <repo>/herdr-plugin --enabled` command from the error, then `herdr plugin list`. |
| "no agent definitions found" | No role files | Add a markdown file with `name`, `description`, `tools` frontmatter. |
| `profile "x" cannot be used: profiles are disabled` | `enableProfiles` is not `true` | Set it in the highest-precedence file named in the error. |
| `unknown profile "x"` | Typo, or the profile is in a lower-precedence file | Check the names in the error and that profile's config file. |
| `env "DEBUG" … is not a string` | A non-string `env` value | Quote it: `"DEBUG": "0"`. Booleans and numbers are skipped, not converted. |
| `env key "a b" … is not a valid shell identifier` | Key is not a shell name | Use letters, digits and `_`, not starting with a digit. |
| A spawn acknowledges but no result arrives | The child is still running | Results arrive only on completion; a long child holds the batch — watch its pane. |
| Warnings about unmatched tool patterns | A `tools` entry matched no real tool | Fix the typo or wildcard in that role's frontmatter. |
| "Nested delegation is not supported yet" | A role lists `subagent` in `tools` | Remove it from that role's frontmatter. |

Config warnings are also surfaced as a notification at session start.

## Development

```bash
npm install
npm test          # unit tests (node --test)
npm run typecheck # tsc --noEmit
```

Smoke tests drive real herdr panes with a real pi child, and need a herdr session with
the `tinysubagent-panes` plugin linked and enabled:

```bash
npm run smoke            # end-to-end: plan artifacts, open pane, run a child, classify the result
npm run smoke:tool       # drives the tool through a stub ExtensionAPI, asserts the steer message
npm run smoke:interrupt  # interrupt handling in a child pane
```

`smoke` and `smoke-tool` take an agent name and flags, e.g.
`node scripts/smoke.ts scout light --parallel`, or `--bogus` for the failure path (an
impossible model, expecting `failed` with the pane left open).

Install a local checkout with `pi install /absolute/path/to/tinysubagent` (directories are
added to settings without copying).

## License

MIT — see the `license` field in [package.json](package.json). Author: Ironman.
