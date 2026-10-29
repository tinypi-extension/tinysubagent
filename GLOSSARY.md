# tinysubagent

A delegation layer for pi: an orchestrator session hands work to subagents that run in their own panes and each hand back one report.

## Delegation

**Orchestrator**:
The pi session that calls the subagent tool, owns the briefs, and receives the reports.
_Avoid_: parent, caller, main agent

**Subagent**:
A separately launched agent process with its own context window and its own pane, started by one spawn.
_Avoid_: child agent, worker, worker agent

**Child**:
The subagent as seen from the process side — the thing that settles, reports, and can be interrupted. Same entity as the subagent, named by the role it plays in the launch.
_Avoid_: process, task

**Role**:
A reusable, named definition of how a subagent should behave, written as markdown and selected per spawn.
_Avoid_: agent, agent type, persona

**Brief**:
The instruction the orchestrator writes for one spawn: what that child is to accomplish.
_Avoid_: task, prompt, message

**Label**:
The short name attached to a spawn so its pane, acknowledgment, and result can be told apart from its siblings.
_Avoid_: id, title, name (a role has a name; a spawn has a label)

**Spawn**:
One act of opening a pane and starting a child with a role, brief, profile, and label.
_Avoid_: launch, run, invocation

**Batch**:
All children started by a single tool call — one, or up to four in parallel — whose results are reported back together.
_Avoid_: group, queue, set

**Steer**:
A message injected into a running session. It is how a report reaches the orchestrator, and how a human redirects a child in its pane.
_Avoid_: send, message, notify

## Report and outcome

**Report**:
The child's explicit hand-back of its complete result, passed as an argument rather than inferred. The report is what the orchestrator receives and what ends the wait.
_Avoid_: result, output, answer (the report carries the result)

**Session record**:
The append-only log a child's harness writes as it runs. It is where the child's words live, never where its outcome is declared.
_Avoid_: transcript, log, history

**Sidecar**:
The artifact a child leaves beside its session record to hand its result back. It is authoritative over anything scraped from that record; a `failed` payload in it is older-build or agy-wrapper input that the reader still classifies.
_Avoid_: status file, marker, metadata

**Settle**:
The moment a child's agent loop finishes and nothing further will run. It is not an ending: the child stays at its prompt, and only a report, `/quit`, or the pane's fate ends the wait.
_Avoid_: finish, end, completion

**Unreported turn end**:
A settle with no report. It is not an ending: the child stays alive at its prompt with its context intact, and the wait continues.
_Avoid_: silent completion, implicit done

**Interrupt**:
An operator stopping the child's current turn without ending the child, so it can be redirected. Also not an ending.
_Avoid_: cancel, abort, kill (to cancel is to lose the pane)

**Outcome**:
What finally ended a wait: completed, failed, or cancelled — plus how that was learned (a result report, an exit code, a legacy `failed` payload, or a vanished pane).
_Avoid_: status, state, verdict (a verdict is the internal reading that produces an outcome)

**Refusal**:
pi declining to run the prompt at all — no usable model or credentials. Nothing is reported and the child stays at its prompt, so a human can log in and drive it on.
_Avoid_: error, failure (a refusal happens before any run exists)

**Hold open**:
Keeping a child's pane visible briefly after an early crash, so a human can read why it failed instead of watching the pane vanish.
_Avoid_: keep alive, linger

## Roles and profiles

**Profile**:
A named bundle of subagent settings — harness, model, and thinking level — chosen per spawn.
_Avoid_: role, preset, config

**Harness**:
The CLI that runs a child, either pi or agy.
_Avoid_: runner, backend, engine

**Thinking level**:
How much reasoning to ask of a child's model, expressed in one shared scale and translated to each harness's own dial.
_Avoid_: effort (legacy alias only), budget

**Current**:
The built-in profile meaning "match the orchestrator". It cannot be redefined.
_Avoid_: default, inherit, session

**Enabled profiles**:
The opt-in that makes named profiles usable. Without it, Current is the only profile offered.
_Avoid_: custom profiles

**Allowlist**:
A child's explicit restriction to a tool list, rather than its harness's normal tool set. It exists when a role declares `tools` or a default-tools floor is set.
_Avoid_: permissions, toolset, whitelist

**Default tools**:
The tool floor configured once for every child, so a role need not restate it. A role may subtract from it or opt out of it.
_Avoid_: base tools, global allowlist, global tools

**Tool list**:
The set of tools a child may use, composed from the default tools and the role's own `tools` entry.
_Avoid_: toolset, whitelist, permissions

## Routing and settings

**Routing**:
Choosing a child's profile from its brief instead of the orchestrator naming one.
_Avoid_: selection, dispatch, auto-profile

**Classifier**:
The in-process model that answers a routing question. Routing is active exactly when one is configured.
_Avoid_: router, SystemOne

**SystemOne**:
The legacy remote service that used to answer routing questions. Superseded by the classifier; its keys still resolve, with a warning.
_Avoid_: classifier

**Scope**:
Where a setting was found — project or global. Project beats global, and scope beats filename, so a plain file in the nearer scope outranks a commented one further away.
_Avoid_: level, layer

**Override**:
The single settings file that replaces every scope when named. When it is set, it is the only file read.
_Avoid_: env config

**Config warning**:
A problem in a settings file that is surfaced at session start and then survived. Malformed settings never abort a session.
_Avoid_: config error

## Panes and layout

**Pane**:
A terminal region herdr manages. Every live child owns one.
_Avoid_: window, tab, split, terminal

**Sub pane**:
A pane holding a live subagent, as opposed to the orchestrator's own pane.
_Avoid_: child pane, side pane

**Live sub panes**:
The set of sub panes that still exist in the tab. It — not the current batch — is what placement and sizing act on.
_Avoid_: registry, pane list

**Column**:
The single right-hand stack that all sub panes share, divided equally among them.
_Avoid_: stack, sidebar, panel

**Column birth**:
The first sub pane in a tab. It is the only moment the orchestrator's share is set.
_Avoid_: first split, initial layout

**Orchestrator-first layout**:
The rule that the orchestrator keeps three fifths of its rect and every live sub pane shares the rest.
_Avoid_: split layout, balanced layout

**Ack**:
The immediate acknowledgment the orchestrator sees when a spawn starts, before any result exists.
_Avoid_: confirmation, receipt, response

## Readiness

**Capability probe**:
The cached check that herdr is reachable and new enough to open sub panes at all.
_Avoid_: environment check, health check

**Readiness**:
The probe's answer: either an empty problem or a description of what is wrong, paired with at most one fix.
_Avoid_: status, health

**Plugin fix**:
The one-step repair offered when the pane entrypoint is not linked or not enabled.
_Avoid_: auto-fix, install
