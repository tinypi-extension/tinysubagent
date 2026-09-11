# tinysubagent

Minimal, herdr-native subagent spawning for [pi](https://pi.dev). Define roles as
markdown files, then delegate work to them — each subagent runs in its own herdr
pane with an isolated context window and reports back to your session.

- **Markdown roles.** `~/.pi/agent/agents/*.md` and `<project>/.pi/agents/*.md`, with
  `name`, `description` and `tools` frontmatter.
- **Fire-and-forget.** A spawn opens the panes and returns immediately. Each child's
  result arrives later as a **steer message** that wakes your session.
- **Single or parallel.** One task, or up to 8 at once. A batch reports back together
  in one labelled message.
- **Model profiles.** Optional `light` / `core` / `pro`-style profiles pin a model and
  thinking level per subagent.
- **Small enough to read.** One `index.ts` plus a handful of focused modules.

The tool is registered **only when pi is running inside herdr**. Outside herdr there is
no pane to split, so the tool is not offered at all rather than offered and failing.

## Requirements

| Requirement | Details |
| --- | --- |
| pi | The pi coding agent. |
| herdr | **0.8.2 or newer** — split plugin panes. Check with `herdr --version`. |
| herdr running | `herdr status server --json` should report `"running": true`. |
| The `tinysubagent-panes` herdr plugin | Ships with this repo at `herdr-plugin/`. pi offers to link it on the first session inside herdr — one keypress, nothing copied or installed from elsewhere. |
| pi started inside a herdr pane | The tool is registered only when `HERDR_ENV=1`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` are set. |

## Install

### 1. Install the extension

The latest code is on the repository's default branch. Install it **without a ref** so
`pi update --extensions` keeps it current:

```bash
pi install git:github.com/tinypi-extension/tinysubagent
```

Use the SSH form if you have SSH access configured instead of HTTPS:

```bash
pi install git:git@github.com:tinypi-extension/tinysubagent
```

Install into project settings (`.pi/settings.json`, shared with your team) instead of
your user settings (`~/.pi/agent/settings.json`) with `-l`:

```bash
pi install -l git:github.com/tinypi-extension/tinysubagent
```

To try it without installing anything, use `-e` (temporary, current run only):

```bash
pi -e git:github.com/tinypi-extension/tinysubagent
```

#### Pinning a release

`v0.1.0` was the first release. Pinning is reproducible, but it also freezes you on that
tag — fixes shipped afterwards will not reach you until you pin a newer tag:

```bash
pi install git:github.com/tinypi-extension/tinysubagent@v0.1.0
```

Pinned git refs are checkout targets, so `pi update --extensions` reconciles the clone to
that same tag instead of moving it forward. To upgrade, install a newer tag explicitly:

```bash
pi install git:github.com/tinypi-extension/tinysubagent@v0.2.0
```

For the common case, prefer the unpinned install from step 1 and update with:

```bash
pi update --extensions   # updates installed packages and reconciles git refs
pi list                  # show what is installed
```

> **Security:** pi packages run with full system access. Review the source before
> installing third-party packages.

### 2. Link the herdr plugin

The pane entrypoint **ships with the package**, in `herdr-plugin/`: plugin id
`tinysubagent-panes`, entrypoint `subagent`. herdr stores the absolute path and copies
nothing, so the link points at the directory where the plugin really lives.

**You do not have to run this by hand.** Start pi inside a herdr pane and, if the plugin
is missing or disabled, the extension asks before your first prompt:

```
Link the tinysubagent herdr plugin?
```

Confirm and it runs the link for you. Nothing is touched without that confirmation —
decline and you can run it yourself whenever you like:

```bash
herdr plugin link /path/to/tinysubagent/herdr-plugin --enabled
```

In a local checkout you can use the relative form, or the repo script:

```bash
cd /path/to/tinysubagent
herdr plugin link ./herdr-plugin --enabled
# or: npm run link-plugin
```

Unsure where `pi install` put the package? Trigger the `subagent` tool once, or decline
the offer: the "not installed" error prints the exact path to link.

Linking is only offered where pi can prompt — interactive and RPC sessions. In print or
JSON mode there is no dialog, so nothing is linked and the tool reports the command
instead.

To confirm it is present and enabled:

```bash
herdr plugin list
# → tinysubagent-panes (Tiny Subagent Panes) enabled
```

If it shows up disabled:

```bash
herdr plugin enable tinysubagent-panes
```

### 3. Verify

```bash
pi list                  # tinysubagent should appear
herdr plugin list        # tinysubagent-panes should be enabled
```

Start (or restart) pi **inside a herdr pane**. You should now see a `subagent` tool, and
your roles listed in its description. If not, see [Troubleshooting](#troubleshooting).

## Define a role

A role is a markdown file with YAML frontmatter. The body becomes the child's system
prompt.

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

Save it as `~/.pi/agent/agents/scout.md` (available everywhere) or
`<project>/.pi/agents/scout.md` (available in that project).

Load order:

1. User roles: `<agentDir>/agents/*.md` — `~/.pi/agent/agents/` by default, or
   `$PI_CODING_AGENT_DIR/agents/` when that variable is set.
2. Project roles: `<project>/.pi/agents/*.md`.

On a name clash the **project definition wins**, so a repository can pin its own reviewer
without editing the global one. Files are read in name order.

Frontmatter fields:

| Field | Required | Notes |
| --- | --- | --- |
| `name` | No | Defaults to the filename. Used to select the role. |
| `description` | Recommended | Advertised in the tool description. A missing description produces a warning and the role is still usable. |
| `tools` | No | Allowlist for the child. A comma/whitespace-separated string or a YAML list. `*` wildcards match any run of characters (e.g. `codegraph_*`, `mcp__*`). |

Notes on `tools`:

- `subagent_report`, the child-side hand-back tool, is added to the allowlist automatically,
  so a role can always return its result.
- Without `tools`, the child gets **no allowlist** — it inherits pi's normal tool set.
- A literal name is kept even if nothing matches, so a renamed tool shows up as a warning
  instead of a silently narrowed allowlist. Wildcard patterns that match nothing are also
  reported as warnings on the spawn acknowledgment.
- **Nested delegation is not supported.** Listing `subagent` in a role's `tools` fails the
  spawn with an explanation, because the child's pane closes when its own turn settles and
  would strand its children's results.

The tool description advertises at most **12 roles**, and each advertised description is
clipped at 120 characters. Every role is still selectable even if it is not listed — the
truncation only affects what the model sees.

## Use it

Ask pi to delegate, or call the tool yourself. The tool name is `subagent`.

Single subagent:

```
subagent({ agent: "scout", task: "Map how config resolution works in src/config.ts and report the precedence order.", name: "config-recon" })
```

Parallel subagents (up to 8, each in its own pane):

```
subagent({
  tasks: [
    { agent: "scout",   task: "Find every call site of spawnOne and report them.",            name: "spawn-sites" },
    { agent: "worker",  task: "Add a unit test for resolveProfile with an unknown profile.",  name: "profile-test", profile: "light" }
  ]
})
```

Parameters:

| Parameter | Applies to | Notes |
| --- | --- | --- |
| `agent` | single | Role name, from the roles listed in the tool description. |
| `task` | single | Complete, self-contained brief. The child cannot see this conversation. |
| `tasks` | parallel | Array of `{ agent, task, name?, profile? }`. Maximum 8. |
| `name` | both | Label for the pane and for the result. Defaults to the agent name. |
| `profile` | both | Only present when profiles are enabled. Defaults to inheriting your session's model and thinking. |
| `cwd` | both | Working directory for the subagents. Defaults to this session's cwd. |

What happens after a call:

1. The call returns immediately with an acknowledgment line per child
   (`scout (config-recon) ...`), plus the panes opened.
2. You end your turn and wait. Do nothing else — no polling, no unrelated work — the
   result arrives on its own.
3. When the children finish, **one steer message** arrives for the batch, labelled per
   child, with each result. Failed children are marked `failed` and their pane is left
   open so the reason stays readable.
4. Completed children's panes are closed. A failed pane is deliberately left on screen.

Because children run in real panes, you can type into one at any time. Pressing Esc in a
child **is not a completion**: that child stays in the batch with its pane open, and the
batch is held until it reports for real or its pane goes away. Interrupting a child does
not produce a `failed` result.

## Profiles

A profile is a `{ model, thinking }` pair a child is launched with. Profiles are
configured in a standalone file — deliberately **not** in pi's `settings.json`.

```jsonc
// ~/.pi/agent/tinysubagent.jsonc
{
  "enableProfiles": true,
  "profiles": {
    "light": { "model": "<provider>/<small-model>",  "thinking": "low" },
    "core":  { "model": "<provider>/<default-model>", "thinking": "medium" },
    "pro":   { "model": "<provider>/<large-model>",  "thinking": "high" }
  }
}
```

Use the model ids pi accepts — `pi --list-models` prints them. A profile with only
`thinking` (or only `model`) is valid; the missing half falls back to your session's value.

Rules:

- `current` is a built-in profile meaning "inherit this session's model and thinking
  level". It is always available and **cannot be redefined** — a config that tries is
  ignored with a warning.
- A named profile is refused unless `enableProfiles` is literally `true`. When profiles
  are off, the `profile` parameter is removed from the tool schema entirely, so the model
  is never offered a knob that does nothing.
- A profile's `model` and `thinking` are optional; each falls back to your session's value.
- Accepted `thinking` values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
  An unknown value is ignored with a warning.
- A missing config file is the documented default state: same as `enableProfiles: false`.

### Config file resolution

| Precedence | File |
| --- | --- |
| 1 | `$PI_TINYSUBAGENT_CONFIG` — the only file read; nothing layers under it |
| 2 | `<project>/.pi/tinysubagent.jsonc` |
| 3 | `<project>/.pi/tinysubagent.json` |
| 4 | `~/.pi/agent/tinysubagent.jsonc` |
| 5 | `~/.pi/agent/tinysubagent.json` |

Two independent rules:

- **Scope beats filename.** A project `.json` outranks a global `.jsonc`.
- **Within one directory**, `.jsonc` wins over `.json` and the sibling `.json` is ignored
  silently — writing a `.jsonc` is all it takes to switch over.

Files **layer**, they do not replace each other: `profiles` merge by name with the higher
scope winning per name, so a project file can add one profile and still inherit every
global one. `enableProfiles` comes from the highest-precedence file that specifies the
key. Both `.json` and `.jsonc` are read with comments and trailing commas allowed, so a
repo can carry an annotated file.

A file that is unreadable or unparseable is skipped with a warning naming it, and the next
scope still applies — a broken project file can never disable profiles that were already
working.

To commit a project config when your `.gitignore` has a bare `.pi/` rule, you need a
negation pair (git cannot re-include a file under an excluded directory):

```gitignore
.pi/*
!.pi/tinysubagent.jsonc
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No `subagent` tool at all | pi is not running inside herdr | Start pi from a herdr pane. The tool is only registered when `HERDR_ENV=1`, `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` are set. |
| "herdr is not reachable from this pane" | The herdr server stopped | `herdr status server --json`; restart herdr. |
| "herdr >= 0.8.2 is required" | Old herdr | Update herdr, then restart the herdr session. |
| "the herdr plugin ... is not installed" / "is disabled" | The bundled pane entrypoint was never linked, or the offer was declined | Confirm the prompt at session start, or run the exact `herdr plugin link <repo>/herdr-plugin --enabled` command from the error, then `herdr plugin list`. |
| "no agent definitions found" | No role files | Add a markdown file with `name`, `description` and `tools` frontmatter to `~/.pi/agent/agents/` or `<project>/.pi/agents/`. |
| `profile "x" cannot be used: profiles are disabled` | `enableProfiles` is not `true` | Set `"enableProfiles": true` in the highest-precedence config file named in the error. |
| `unknown profile "x"` | Typo, or the profile lives in a lower-precedence file | Check the names in the error and the profile's config file. |
| A spawn acknowledges but no result ever arrives | The child is still running | Results arrive only when a child finishes. A long-running child holds the batch; watch its pane. |
| Warnings about unmatched tool patterns | A `tools` entry matched no real tool | Fix the typo or the wildcard in that role's frontmatter. |
| "Nested delegation is not supported yet" | A role lists `subagent` in its `tools` | Remove `subagent` from that role's frontmatter. |

Config warnings are also surfaced as a notification when a session starts.

## Development

```bash
npm install
npm test                 # unit tests (node --test)
npm run typecheck        # tsc --noEmit
```

Smoke tests drive real herdr panes with a real pi child. They require a herdr session
(pi must be started inside a herdr pane) with the bundled `tinysubagent-panes` plugin
linked and enabled:

```bash
npm run smoke            # end-to-end: plan artifacts, open pane, run a child, classify the result
npm run smoke:tool       # drives the registered tool through a stub ExtensionAPI and asserts the steer message
npm run smoke:interrupt  # interrupt handling in a child pane
```

`smoke` and `smoke-tool` accept an agent name and flags, e.g.
`node scripts/smoke.ts scout light --parallel`, or `--bogus` to exercise the failure path
(an impossible model, expecting `failed` with the pane left open).

Install a local checkout with `pi install /absolute/path/to/tinysubagent` (directories are
supported and added to settings without copying), or try the GitHub install without touching
settings using `pi -e git:github.com/tinypi-extension/tinysubagent`.

Releases are cut as git tags (`v0.1.0` was the first). Update the version in
`package.json`, tag the commit, and push the tag — users on the unpinned GitHub install get
it with `pi update --extensions`; users on a pinned tag install the new tag explicitly.

## License

MIT — see [package.json](package.json) for the `license` field. Author: Ironman.
