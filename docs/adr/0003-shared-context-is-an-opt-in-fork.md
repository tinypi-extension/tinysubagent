# A shared context is an opt-in fork of the orchestrator's branch

Status: accepted

A subagent's isolation is the reason delegation is cheap: the brief is the whole of what it knows, and
its cost does not scale with the orchestrator's history. That is also the reason some delegations are
expensive to write — the orchestrator has to restate decisions it already made. So a spawn may now ask
for the orchestrator's context, and the child gets it as a real session fork: the branch copied into
the child's own session file, with a fresh header whose `parentSession` points at the orchestrator's
file. A copy, deliberately, rather than a title: `--fork` would have pi choose the session path, and
the watcher has to read that path, so the file is rebuilt by us at the location the launch recipe
already planned.

Two things make the copy a fork of *a conversation* rather than of *a session record*. The `system`
entries go: the child builds its own prompt from its role and must not inherit the orchestrator's
prompt sections or its tool declarations, which would advertise `subagent` to an agent that cannot
spawn. And the branch is cut after its last user entry: at call time the leaf is the assistant message
that just called `subagent`, and copying that hands the child an unresolved tool call for the rest of
its life plus a half-finished batch it may mistake for its own work.

The rejected alternative was an excerpt or a model-written summary injected into the task markdown. It
is cheaper per spawn, works on both harnesses, and keeps "its own context window" literally true — but
it makes the child's knowledge a function of a truncation policy nobody chose, and its fidelity cannot
be reasoned about by the orchestrator writing the brief. Full fidelity, an explicit per-task flag, and
a visible `shared 42 entries · ~18k tokens` line beat a silent compromise: the orchestrator can see
what a share costs, and can choose not to share.

Consequences: a shared child's cost scales with the orchestrator's history, and a long branch is copied
compacted (the active context is what is shared, not the raw log). The `agy` harness has no session
file, so `shareContext` is refused there rather than silently spawning a clean child; the same refusal
applies when the orchestrator runs `--no-session`. Sharing is one-way: the report is still the only
thing that comes back, because a child pushing context inward would end the "one blocking call, N
reports" contract the rest of the tool is built on.
