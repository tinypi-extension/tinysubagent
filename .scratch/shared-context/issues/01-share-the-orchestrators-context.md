# 01: A subagent can be given the orchestrator's context

**What to build:** With `canShareContext` set true in `tinysubagent.jsonc`, an orchestrator can pass
`shareContext: true` on a task and the spawned subagent starts with the conversation that led to the
brief — its own session file is a fork of the orchestrator's active branch. With the gate off, the
parameter is not offered at all. The child still answers to the brief; the shared context is
background, not an instruction.

The fork is written by us at the planned child session path before the pane opens, so the existing
watcher keeps reading the path it planned:

- header: fresh `id` matching the filename, `version` copied, `cwd` = the request's `cwd`,
  `parentSession` = the orchestrator's session file
- body: the active branch, re-chained linearly, **cut after the last `user` entry**, every `system`
  entry dropped
- the child's prompt and tool allowlist stay its own; argv is unchanged (`--session <file>` already
  opens it)

The cut and the `system` exclusion are the point: at call time the branch leaf is the assistant message
that just called `subagent`, and copying it would hand the child a dangling tool call plus a
half-finished batch it may read as its own work.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] `canShareContext` is read from the highest-precedence config source like `enableProfiles`, default `false`, and documented in the README config table
- [x] `shareContext` appears on the task object in the tool schema only when the gate is on; the task object stays open, so a call that passes it anyway is refused by the tool, by name
- [x] `shareContext: true` on a task produces a child session file whose header has a fresh `id`, the request's `cwd`, and `parentSession` pointing at the orchestrator's session file
- [x] That file contains the orchestrator's branch up to and including its last `user` entry, and every entry's `parentId` chains under the new header `id`
- [x] No `system` entry survives the copy, nor the system prompt pi embeds on a `compaction` entry, and the tail is not the assistant message that called `subagent`
- [x] Tool description and prompt guidelines stop claiming a subagent cannot see the conversation when the gate is on, and still say so when it is off
- [x] A spawn with `shareContext` false, or with the gate off, is byte-for-byte the launch it is today
- [x] A share never reaches a harness that cannot honour it (an `agy` profile does not get a fork file it would never read)

## Resolution

Landed on `integration/shared-context`: `44ce948`, `5b2197d`, `4238347`, `0aa71ed`, then review fixes `8be77f9` (a benign extra key no longer fails the batch) and `9da7695` (the copied branch is scrubbed of any embedded system prompt — pi 1.5.2 stores one on a `compaction` entry and replays it on load). The fork's own cost and line count are reported by `shared-context.ts` rather than recomputed by its callers.
