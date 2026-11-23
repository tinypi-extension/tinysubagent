# Spec: Sharing the orchestrator's context with a subagent

Status: ready-for-agent

Tickets: `issues/01` (the share itself), `issues/02` (refusals), `issues/03` (the size line).

## What it is

A subagent's context window is normally empty: the brief is the whole of what it knows. This adds a
way for the orchestrator to hand a child the conversation that led to the delegation, per spawn, by
forking its own session branch into the child's session file.

Two gates, and nothing else:

| Gate | Where | Meaning |
|---|---|---|
| `canShareContext` | `tinysubagent.json` / `.jsonc`, top-level boolean, default `false` | Permits the capability. When `false`, `shareContext` is not in the tool schema at all, and a call that names it anyway is refused by the tool, by name. |
| `shareContext` | `subagent` tool, per task, boolean, default `false` | Decides it for this spawn. |

Profiles are not involved. A profile stays harness + model + thinking; sharing is not one of its
dimensions.

## Is it possible (verified)

- The orchestrator's branch is reachable from the tool body: `ctx.sessionManager.getSessionFile()`,
  `getBranch()`, `buildContextEntries()`.
- Child session paths are planned by us before launch, and the sidecars are named off them
  (`src/children/launch-paths.ts`: `exitCodeFile`, `reportFile`). So pi's `--fork` — which picks its
  own session path — is unusable: the watcher would have nothing to read. The fork is produced by
  *us*, written to the planned `childSessionFile`, and opened with the existing `--session`.
- A session JSONL is `{type:"session", version, id, timestamp, cwd, parentSession?}` then entries
  linked by `id`/`parentId`; `parentSession` is exactly what `/fork` records. A file we write
  ourselves is therefore an honest fork, not an imitation.
- The orchestrator's file contains `system` message entries (prompt sections + tool declarations) and
  may contain abandoned branches. Neither belongs in a child.

## The fork recipe

Written by the spawn recipe, before the pane opens, at the planned `childSessionFile`:

1. Header: fresh `id` (matching the uuid in the filename, as pi names files
   `<timestamp>_<session-id>.jsonl`), `version` copied, `cwd` = the request's `cwd`, `parentSession` =
   the orchestrator's session file.
2. Body: the active branch (`buildContextEntries()`, so an already-compacted branch is copied
   compacted), re-chained linearly under the new header, **cut after the last `user` entry**.
3. Excluded: every `system` entry.

Why the cut: at call time the branch leaf is *the assistant message that just called `subagent`*, with
no result. Copying it hands the child a dangling `tool_use` on every request it makes, and invites it
to read a half-finished batch as its own work. Cutting after the last user entry leaves the child the
orchestrator's request and everything before it, and nothing about the delegation itself.

Why exclude `system`: the child builds its own prompt from its role, and inheriting the orchestrator's
prompt sections and tool declarations would advertise `subagent` to a child that cannot spawn and
overwrite the allowlist the role declared.

## Refusals

Every refusal is per request: an error on that request rather than a failed batch, and never a silently
clean child. A refused request opens no pane and writes no launch file; its siblings in the batch spawn
exactly as they would have.

The reasons:

- `shareContext: true` when `canShareContext` is not true. The schema omits the key while the gate is
off, but the task object is open, so the tool refuses a call that names it anyway — by name, quoting
the gate and the file that would set it.
- `shareContext: true` on a request whose profile resolves to the `agy` harness — there is no session
  file to fork from agy.
- `shareContext: true` when the orchestrator runs `--no-session`, so there is no file to fork.
- `shareContext: true` when the branch has no user entry yet, so the fork would be a header and nothing
  else: there is no conversation to share, and spawning clean anyway would answer a brief written as if
  the child had read one.

## What it costs, and what is said about it

No cap: the branch is copied as it is. The size is surfaced instead — entry count and rough tokens in
the acknowledgment row and the result meta — so a human can see when a share was expensive.

One-way only. Nothing flows from the child back beyond its report; sharing the child's context inward
would break the "one blocking call, N reports" contract.

## Where the code goes

- `src/config/config.ts`: `canShareContext` on `TinysubagentConfig`, parsed like `enableProfiles`
  (top-level boolean, highest-precedence scope wins), plus the README config table.
- `src/present/describe.ts`: `buildParameters` adds `shareContext` to the task object only when
  `canShareContext` is true; `buildToolDescription` stops claiming "a subagent cannot see this
  conversation" when the capability is on, and `PROMPT_GUIDELINES` gains the sentence that says what a
  shared context does and does not replace (the brief is still the brief).
- `src/children/requests.ts` / `src/types.ts`: carry the flag on `SpawnRequest`, and refuse it per
  request — the gate off, the profile agy, no session file to fork, or nothing forkable on the branch.
- New module (e.g. `src/children/shared-context.ts`): read the branch from the `ExtensionContext`,
  render the fork JSONL, return `{ entries, tokens }` for the ack. Pure enough to test without panes.
- `src/children/spawn.ts` + `src/children/launch.ts`: write the fork file to `paths.childSessionFile`
  before the pane opens; the argv is unchanged (`--session <file>` already opens it).
- `src/present/ack.ts` / `ack-render.ts` / `result.ts`: the `shared 42 entries · ~18k tokens` line.

## Out of scope

- Per-profile sharing, sharing back, capping or summarizing the branch, inherited context for agy.
- A settings-TUI row for `canShareContext` (the config file and README are the surface for now).
- Nested delegation, unchanged: a child still cannot spawn.
