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

**Status:** ready-for-agent

- [ ] `canShareContext` is read from the highest-precedence config source like `enableProfiles`, default `false`, and documented in the README config table
- [ ] `shareContext` appears on the task object in the tool schema only when the gate is on; the task object stays open, so a call that passes it anyway is refused by the tool, by name
- [ ] `shareContext: true` on a task produces a child session file whose header has a fresh `id`, the request's `cwd`, and `parentSession` pointing at the orchestrator's session file
- [ ] That file contains the orchestrator's branch up to and including its last `user` entry, and every entry's `parentId` chains under the new header `id`
- [ ] No `system` entry survives the copy, and the tail is not the assistant message that called `subagent`
- [ ] Tool description and prompt guidelines stop claiming a subagent cannot see the conversation when the gate is on, and still say so when it is off
- [ ] A spawn with `shareContext` false, or with the gate off, is byte-for-byte the launch it is today
- [ ] A share never reaches a harness that cannot honour it (an `agy` profile does not get a fork file it would never read)
