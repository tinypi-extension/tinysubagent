# tinysubagent

Herdr-native subagent spawning for [pi](https://pi.dev). Define roles as markdown files and
delegate to them. Each subagent runs in a shared right-hand [herdr](https://herdr.dev/) column
with its own context window, and reports back as a steer message.

- **Fire-and-forget:** spawns return immediately; results wake your session later.
- **Single or parallel:** one task, or up to 4 reporting in one message. 
- **Model profiles:** optional named profiles with a shared `model` and `thinking` setting for pi or agy.
- **Per-child `env`:** static variables for subagents, without touching the orchestrator's env.

The tool is registered **only inside herdr**. Outside it there is no pane to split, so it is not offered.

## Requirements
- Pi coding agent.
- herdr version 0.8.2 or newer

## Install

```bash
pi install git:github.com/tinypi-extension/tinysubagent  
pi update --extensions  
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
- Nested delegation is unsupported.

## Profiles

A profile selects the child CLI with `harness` (`pi`, the default, or `agy`) and supplies
a shared model and thinking level, translated to the harness's supported setting. Configure profiles in
`~/.pi/agent/tinysubagent.jsonc`:

```jsonc
{
  "enableProfiles": true,
  "profiles": {
    "light": { "model": "<provider>/<small-model>", "thinking": "low" },
    "core":  { "model": "<provider>/<default-model>", "thinking": "medium" },
    "agy-medium": { "harness": "agy", "model": "gpt-oss-120b-medium", "thinking": "medium" }
  }
}
```

- `current` is built in. It means "inherit this session" and **cannot be redefined** (a config
  that tries is ignored with a warning).
- Named profiles are refused unless `enableProfiles` is literally `true`. 
- `harness` defaults to `pi`. Valid values are `pi` and `agy`; an unknown harness drops that profile with a warning.
- `model` is optional and falls back to the session's model for pi; agy profiles should specify a model.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` for either harness. 
- The old `effort` key remains a silent alias for `thinking` at `low`/`medium`/`high`. If both are set, `thinking` wins.
- Agy profiles do not support role `tools` allowlists. Such a spawn is refused; use a pi profile instead.
- Set `TINYSUBAGENT_AGY_BIN` to override the `agy` executable path.

### Using the agy harness

Install and sign in to the `agy` CLI separately. Agy profiles launch interactively in their own
herdr pane; the model may pause for approval, and you can review or steer it there. Agy does not
enforce role `tools` allowlists, so tinysubagent refuses agy spawns for roles that declare one.

Each run gets a temporary workspace containing its Stop hook. To let agy load the hook without a
first-run trust prompt, tinysubagent temporarily adds that workspace to
`~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`, then removes the entry when the run
ends. Existing trust entries are preserved. The workspace and hook are removed after the child exits.

### Config resolution

| Precedence | File |
| --- | --- |
| 1 | `$PI_TINYSUBAGENT_CONFIG` (the only file read when set) |
| 2 | `<project>/.pi/tinysubagent.jsonc` |
| 3 | `<project>/.pi/tinysubagent.json` |
| 4 | `~/.pi/agent/tinysubagent.jsonc` |
| 5 | `~/.pi/agent/tinysubagent.json` |

- **Within one directory**, `.jsonc` wins and the sibling `.json` is silently ignored.
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
- **Every failure falls back to `current`**, never delaying a spawn beyond a 2 s budget.

A configured key also powers the **report check** in each child. When a subagent's turn ends without
a `subagent_report` call, the child sends its final message to the same service. 

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
- `"FOO": ""` exports `FOO` as set but empty. Omit the key to leave it unset.
- **Merged per key**, project over global, like `profiles`. A `$PI_TINYSUBAGENT_CONFIG` override replaces both.
- **Collisions go to the launcher.** `PATH`, `PI_CODING_AGENT_DIR`, and the `PI_TINYSUBAGENT_*` variables
  children use to report back are written after `env`, so a config value with the same name is overwritten.

## License

MIT. See [LICENSE](LICENSE). 
