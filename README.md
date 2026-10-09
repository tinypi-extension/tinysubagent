# tinysubagent

Herdr-native subagent spawning for [pi](https://pi.dev). Define roles as markdown files and
delegate to them. Each subagent runs in a shared right-hand [herdr](https://herdr.dev/) column
with its own context window, and reports back as a steer message.

- **Fire-and-forget:** spawns return immediately; results wake your session later.
- **Single or parallel:** one task, or up to 4 reporting in one message. The orchestrator keeps
  3/5 of the split; live subagents share one stacked, equal-height column.
- **Model profiles:** optional named `{ model, thinking }` pairs (`light`, `core`, `pro`, or any names).
- **Per-child `env`:** static variables for subagents, without touching the orchestrator's env.

The tool is registered **only inside herdr**. Outside it there is no pane to split, so it is not offered.

## Requirements

| Requirement | Details |
| --- | --- |
| pi | The pi coding agent. |
| herdr | **0.8.2 or newer** (`herdr --version`). |

## Install

```bash
pi install git:github.com/tinypi-extension/tinysubagent   # or git@github.com:...
pi update --extensions     # update; `pi list` to inspect
```

Install **without a ref** so updates keep working. Pinned refs are checkout targets; to upgrade,
install the newer tag explicitly.

### Link the herdr plugin

The pane entrypoint ships in `herdr-plugin/` (plugin id `tinysubagent-panes`, entrypoint
`subagent`). herdr stores the absolute path and copies nothing. Pi asks before your first prompt.

### Reinstall over an existing install

herdr stores the **absolute path** of the linked plugin, and the plugin id never changes. Reinstalling
from a new checkout, a moved repo, or a switch from a local path to `git:...` leaves the old link in
place, so the reinstall appears to do nothing and herdr keeps running the old directory.

Remove the stale link, then let pi link the new one:

```bash
herdr plugin unlink tinysubagent-panes   # drop the stale, path-pinned link
herdr plugin list                        # verify: no tinysubagent-panes entry
pi                                       # start pi inside a herdr pane
# confirm the "Link the tinysubagent herdr plugin?" prompt
herdr plugin list                        # verify: enabled  [local:/path/to/new/herdr-plugin]
```

### Verify

`pi list` shows tinysubagent, `herdr plugin list` shows the plugin enabled, and pi restarted inside
a herdr pane lists a `subagent` tool with your roles. Otherwise see [Troubleshooting](#troubleshooting).

## Define a role

A role is a markdown file with YAML frontmatter. The body is the child's system prompt.
See [`sample_agent/`](sample_agent/) for examples.

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

Save as `~/.pi/agent/agents/scout.md` (all projects) or `<project>/.pi/agents/scout.md` (one project).

Load order: user roles (`<agentDir>/agents/*.md`, i.e. `~/.pi/agent/agents/` or
`$PI_CODING_AGENT_DIR/agents/`), then project roles. On a name clash the **project definition wins**.
Files load in name order.

| Field | Required | Notes |
| --- | --- | --- |
| `name` | No | Defaults to the filename. Selects the role. |
| `description` | Recommended | Shown in the tool description. Missing → warning; role still works. |
| `tools` | No | Child allowlist: comma/space-separated string or YAML list. `*` matches any run of characters (`codegraph_*`, `mcp__*`). |

Notes on `tools`:

- `subagent_report` (the child's hand-back tool) is always added.
- Without `tools`, the child has **no allowlist** and inherits pi's normal tool set.
- A literal name is kept even if nothing matches, so a renamed tool warns instead of silently
  narrowing the list. Unmatched wildcards also warn on the spawn acknowledgment.
- **Nested delegation is unsupported.** Listing `subagent` fails the spawn. A grandchild's result
  lands in the subagent's own session and never reaches the orchestrator.

## Profiles

A profile is a `{ model, thinking }` pair a child launches with. Configure it in
`~/.pi/agent/tinysubagent.jsonc`:

```jsonc
{
  "enableProfiles": true,
  "profiles": {
    "light": { "model": "<provider>/<small-model>",   "thinking": "low" },
    "core":  { "model": "<provider>/<default-model>", "thinking": "medium" },
    "pro":   { "model": "<provider>/<large-model>",   "thinking": "high" }
  }
}
```

- `current` is built in. It means "inherit this session" and **cannot be redefined** (a config
  that tries is ignored with a warning).
- Named profiles are refused unless `enableProfiles` is literally `true`. When profiles are off,
  or SystemOne routing is active, the `profile` parameter is removed from the schema.
- `model` and `thinking` are each optional and fall back to the session's value.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unknown values warn and are ignored.

### Config resolution

| Precedence | File |
| --- | --- |
| 1 | `$PI_TINYSUBAGENT_CONFIG` (the only file read when set) |
| 2 | `<project>/.pi/tinysubagent.jsonc` |
| 3 | `<project>/.pi/tinysubagent.json` |
| 4 | `~/.pi/agent/tinysubagent.jsonc` |
| 5 | `~/.pi/agent/tinysubagent.json` |

- **Scope beats filename:** a project `.json` outranks a global `.jsonc`.
- **Within one directory**, `.jsonc` wins and the sibling `.json` is silently ignored.
- Files **layer**: `profiles` merge by name and `env` merges per key, higher scope winning. A project
  file can add one profile or one variable and inherit the rest. `enableProfiles` comes from the
  highest-precedence file that sets it.
- Both formats allow comments and trailing commas.
- An unreadable or unparseable file is skipped with a warning naming it; the next scope applies.
- Edit config in the TUI with `/subagent-settings`.

### Profile routing via classifier model (`classifierModel`)

A `classifierModel` routes **in process** through pi's model registry instead of SystemOne, so
routing works with any classifier pi has credentials for:

```jsonc
{
  "enableProfiles": true,
  "profiles": { "light": { "model": "<small-model>", "thinking": "low" } },
  "classifierModel": "typesafe/jev-latest"          // or "openrouter/typesafe/jev-latest"
}
```

- The value is a pi model reference, `"<provider>/<model-id>"`.
- Set one up with pi's built-in [models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#use-classifier-models)
  or a custom one via [pi-classifier-provider](https://github.com/tinypi-extension/pi-classifier-provider).
- In `/subagent-settings`, the row is a picker.
- Routing is active when `enableProfiles` is `true`, at least one named profile exists, and either
  `classifierModel` or a `systemOneAPIKey` is set.
- **Setting `classifierModel` makes the three `systemOne*` keys inert.** Every config file still
  listing them logs a deprecation warning naming that file.

### SystemOne profile routing (deprecated)

> A configured `classifierModel` supersedes this section. The `systemOne*` keys are then ignored, and
> every config file that still lists them logs a warning naming the file to clean up.

With a SystemOne key set, the orchestrator asks a routing service to pick the profile for each task,
instead of the model choosing `profile` itself:

```jsonc
{
  "enableProfiles": true,
  "profiles": { "light": { "model": "<small-model>", "thinking": "low" } },
  "systemOneAPIKey": "sk-…",                     // secret API key
  "systemOneBaseUrl": "https://api.typesafe.ai", // optional; default shown
  "systemOneModel": "jev-latest"                 // optional; default shown
}
```

- Project scope is inert for all three keys. A checked-in project file cannot enable, disable, or
  redirect routing. Put them in the override or global file.
- **`systemOneModel` fails silently.** If it is absent, blank, non-string, keyless, or project-scoped,
  it falls back to `jev-latest`.
- **Every failure falls back to `current`**, never delaying a spawn beyond a 2 s budget. Failures
  include: no key, timeout, non-2xx/3xx status, unparseable body, no `probabilities`, or a chosen name
  that is not a configured profile. With routing on, `[current]` in a spawn ack means the SystemOne
  call produced **no decision**; `current` is never a routing outcome.

A configured key also powers the **report check** in each child. When a subagent's turn ends without
a `subagent_report` call, the child sends its final message to the same service. If the service says
the work was finished but never reported, the child steers itself a reminder to call it, at most twice.
An unfinished message, a declined answer, or a transport failure leaves the child alone. This needs
only the key (not `enableProfiles` or profiles) and has the same privacy cost: the final message leaves
the machine.

## Environment variables

`env` gives each subagent static variables without changing the main session's environment.

```jsonc
{
  "env": {
    "PROJECT_NAME": "tinysubagent",
    "VERBOSE": "1"
  }
}
```

- **Values must be strings.** Numbers, booleans, `null`, arrays, and objects are skipped with a warning,
  not coerced. `{"DEBUG": false}` would export `"false"`, which shell tests read as *true*. A JSON number
  also loses precision: `1.0` becomes `"1"`, and long ids lose digits.
- **Keys must be shell identifiers** (`[A-Za-z_][A-Za-z0-9_]*`). `"a b"` is skipped with a warning, since
  `export a b=x` breaks the whole launch script.
- `"FOO": ""` exports `FOO` as set but empty. Omit the key to leave it unset.
- **Merged per key**, project over global, like `profiles`. A `$PI_TINYSUBAGENT_CONFIG` override replaces both.
- **Collisions go to the launcher.** `PATH`, `PI_CODING_AGENT_DIR`, and the `PI_TINYSUBAGENT_*` variables
  children use to report back are written after `env`, so a config value with the same name is overwritten.

## Troubleshooting

Most failures are one of three kinds: pi is not inside a herdr pane, the `tinysubagent-panes` plugin is
missing or stale, or a config value was rejected. Config warnings also appear as a notification at session start.

| Symptom | Cause | Fix |
| --- | --- | --- |
| No `subagent` tool | pi is not inside herdr | Start pi from a herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`). |
| "herdr is not reachable from this pane" | herdr server stopped | `herdr status server --json`; restart herdr. |
| "herdr >= 0.8.2 is required" | Old herdr | Update herdr, then restart the herdr session. |
| Plugin "is not installed" / "is disabled" | Entrypoint never linked, or the offer was declined | Confirm the prompt, or run the `herdr plugin link <repo>/herdr-plugin --enabled` command from the error, then check `herdr plugin list`. |
| Reinstall had no effect / old panes still run | herdr kept the old absolute path; the fixed plugin id matches the stale link | `herdr plugin unlink tinysubagent-panes`, start pi inside a herdr pane, confirm the link prompt, then check `herdr plugin list` for the new `[local:...]` path. See [Reinstall over an existing install](#reinstall-over-an-existing-install). |
| "no agent definitions found" | No role files | Add a markdown file with `name`, `description`, `tools` frontmatter. |
| `profile "x" cannot be used: profiles are disabled` | `enableProfiles` is not `true` | Set it in the highest-precedence file named in the error. |
| `unknown profile "x"` | Typo, or the profile lives in a lower-precedence file | Check the names in the error and that profile's config file. |
| `env` warning: `… is not a string` | A non-string `env` value | Quote it: `"DEBUG": "0"`. Booleans and numbers are skipped, not converted. |
| `env` warning: `key "a b" … is not a valid shell identifier` | Key is not a shell name | Use letters, digits, and `_`, not starting with a digit. |
| Warning about an unmatched tool pattern | A `tools` entry matched no real tool | Fix the typo or wildcard in that role's frontmatter. |
| "Nested delegation is not supported yet" | A role lists `subagent` in `tools` | Remove it from that role's frontmatter. |
| Routing warning: `project-scoped, so its routing keys are ignored`, `"systemOneBaseUrl" … has no "systemOneAPIKey"`, `"systemOneAPIKey" … is not a string` / `is empty`, `"systemOneBaseUrl" … is not a usable http(s) URL` | A routing key is malformed, or sits in a file with no effect. Credentials must resolve from one file, and project scope is inert. `systemOneModel` never warns: a bad or misplaced value silently falls back to `jev-latest`. | Routing stays off until fixed. Put both credentials in the same global or override file: a non-empty string key and an `https:` URL (plain `http:` only for loopback). Or remove them. |
| A spawn acknowledges but no result arrives | The child is still running | Results arrive only on completion. A long child holds the batch; watch its pane. |
| Spawn ack shows `[current]` while routing is on | The SystemOne call produced no decision (timeout, error, unusable answer), so the fallback applied | By design. `current` is never a routing outcome, and `[profile]` in an ack is always the *resolved* profile. The same result names the reason on its own line, e.g. `tinysubagent: systemOne routing failed (HTTP 401); keeping "current".` |

## License

MIT. See the `license` field in [package.json](package.json). Author: Ironman.
