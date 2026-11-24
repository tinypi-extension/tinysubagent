# tinysubagent

A delegation layer for pi: an orchestrator session hands work to subagents that run in their own panes and each hand back one report.

## Delegation

**Orchestrator**:
The pi session that calls the subagent tool, owns the briefs, and receives the reports.
_Avoid_: parent, caller, main agent

**Subagent**:
A separately launched agent process with its own context window and its own pane, started by one spawn. The window starts empty unless the brief is bought a shared context.
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

**Shared context**:
The orchestrator's own branch, forked into a child's session file so the child inherits the conversation that led to the brief. Permitted by `canShareContext`, requested per spawn with `shareContext`, off by default, and one-way: what comes back is still only the report.
_Avoid_: inherited context, memory, history (a session record is the log, not what is shared)

**Label**:
The short name attached to a spawn so its pane, acknowledgment, and result can be told apart from its siblings.
_Avoid_: id, title, name (a role has a name; a spawn has a label)

**Spawn**:
One act of opening a pane and starting a child with a role, brief, profile, and label — plus, optionally, a shared context.
_Avoid_: launch, run, invocation

**Batch**:
All children started by a single tool call — one or more, up to four in parallel — whose reports come back together as one tool result.
_Avoid_: group, queue, set

**Steer**:
A message injected into a running session. A report no longer travels this way — the blocking call returns it — so a steer is only how a human redirects a child in its pane, or how the child's own reminder asks a finished turn to report.
_Avoid_: send, message, notify

## Report and outcome

**Report**:
The child's explicit hand-back of its complete result, passed as an argument rather than inferred. It is what ends the wait and what the tool call returns.
_Avoid_: result, output, answer (the report carries the result)

**Session record**:
The append-only log a child's harness writes as it runs. It is where the child's words live, never where its outcome is declared.
_Avoid_: transcript, log, history

**Sidecar**:
The artifact a child leaves beside its session record to hand its result back. It is authoritative over anything scraped from that record; a `failed` payload in it is older-build or agy-wrapper input that the reader still classifies.
_Avoid_: status file, marker, metadata

**Settle**:
The moment a child's agent loop finishes and nothing further will run. It is not an ending: the child stays at its prompt, and only a report, `/quit`, an exhausted reminder budget, or the pane's fate ends the wait.
_Avoid_: finish, end, completion

**Unreported turn end**:
A settle with no report. The child is reminded to report, up to a fixed budget; the settle after that budget is spent writes a content-free completion, which ends the wait as a completion with no summary and leaves the pane open. Until then the child stays alive at its prompt with its context intact, and the wait continues.
_Avoid_: silent completion, implicit done

**Interrupt**:
An operator stopping the whole batch rather than one child: an interrupt in the orchestrator's pane is relayed to every live child, each turn stops where it is, and every pane stopped that way is then closed — while under a plain terminal the same interrupt kills each child's process group instead, since there is no pane to close. Either way the operator stops the work from where they are instead of visiting each child.
_Avoid_: cancel, abort, stop (an interrupt closes the pane it stopped)

**Outcome**:
What finally ended a wait: completed, failed, or interrupted — plus how that was learned (a result report or an exit code, still a legacy `failed` payload, or under a pane host a vanished pane, which is the one route a plain terminal cannot have).
_Avoid_: status, state, verdict (a verdict is the internal reading that produces an outcome)

**Cancelled**:
A wait ended because the pane disappeared without leaving any signal — no report, no exit code. It is the one outcome that says the pane went unexpectedly — never that the extension closed it, which is what an interrupt does on purpose — and the one that says nothing about the work. It exists only under a pane host: a process that dies is learned from its exit code, so a plain terminal never reports a child as cancelled.
_Avoid_: interrupted, aborted, stopped

**Interrupted**:
A wait ended by that interrupt: the child's turn stopped where it was, its pane was then closed, and it carries no summary, so half a report is never read as a report. A session shutting down under a wait ends the wait the same way but leaves the pane open, and the outcome says which of the two happened rather than leaving it to be guessed.
_Avoid_: cancelled, stopped, killed

**Refusal**:
pi declining to run the prompt at all — no usable model or credentials. Nothing is reported and the child stays at its prompt, so a human can log in and drive it on. The wait ends on it only as a never-started failure, after the grace.
_Avoid_: error, failure (a refusal happens before any run exists)

**Never started**:
The failure a child is reported as when pi refused its prompt: no session entry of any role was written within the grace (90s), so no run ever began. Under a pane host its pane is left open, because logging in there is still the fix; in a plain terminal there is no pane to leave open, so the report has to carry the remedy instead of pointing at one.
_Avoid_: no-output, silent failure

**Hold open**:
Keeping a child's pane visible briefly after an early crash, so a human can read why it failed instead of watching the pane vanish. It has no plain-terminal counterpart: with no pane and no tty there is nothing to hold and nobody to read it, so the failure evidence has to reach the report.
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

**Floor**:
The tool list every child starts from, set once so a role need not restate it. A role may add to it or subtract from it, and with no floor and no declaration of its own a child keeps its harness's normal tool set.
_Avoid_: base tools, global allowlist, global tools

**Default tools**:
The configured floor: the `defaultTools` setting and the names and `*` patterns it holds.
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

**Supervisor**:
How a live child is watched and stopped: as a pane in a pane host, or as its own process in a plain terminal. It is the seam a spawn goes through, and it is narrower than a pane host because watching and stopping are all a spawn needs.
_Avoid_: host, backend, pane host (a pane host is one kind of supervisor)

**Pane host**:
A TUI that can host sub panes: herdr or Rex. One kind of supervisor.
_Avoid_: multiplexer, terminal emulator, backend, supervisor

**Plain terminal**:
A session with no pane host detected. Every live child there is supervised as its own process instead of owning a pane, so nobody can watch it, steer it, or read a failure off its screen.
_Avoid_: headless, no-tty, dumb terminal (headless describes the child's run, not the session)

**Pane**:
A terminal region a pane host manages: a pane in herdr, a block in Rex. Every child supervised by a pane host owns one.
_Avoid_: window, tab, split, terminal

**Block**:
Rex's name for a pane.
_Avoid_: pane (when speaking of Rex), window

**Sub pane**:
A pane holding a live subagent, as opposed to the orchestrator's own pane.
_Avoid_: child pane, side pane

**Live sub panes**:
The set of sub panes that still exist in the host's window. It — not the current batch — is what placement and sizing act on.
_Avoid_: registry, pane list

**Column**:
The single right-hand stack that all sub panes share, divided equally among them.
_Avoid_: stack, sidebar, panel

**Column birth**:
The first sub pane in a host window. It is the only moment the orchestrator's share is set.
_Avoid_: first split, initial layout

**Orchestrator-first layout**:
The rule that the orchestrator keeps three fifths of its rect and every live sub pane shares the rest.
_Avoid_: split layout, balanced layout

**Ack**:
The spawn line — role, label, profile and the model it resolved to — for one child. Under a pane host it is drawn only when no wait follows, so a call that launched nothing still names what it declined to do; in a plain terminal the same line opens that child's live line instead.
_Avoid_: confirmation, receipt, response, live line (a live line moves, an ack does not)

**Live line**:
One of at most four per-child lines drawn while a batch runs in a plain terminal: role, label, elapsed time, and the tail of the child's streamed text, refreshed as it runs. They are replaced by the report when the call returns, so they are the only view of a child there is.
_Avoid_: progress bar, status line, spinner, ack

## Readiness

**Capability probe**:
The cached check that the detected pane host is available and can open sub panes at all.
_Avoid_: environment check, health check

**Readiness**:
The probe's answer: either an empty problem or a description of what is wrong, paired with at most one fix.
_Avoid_: status, health

**Plugin fix**:
The herdr-only one-step repair offered when the pane entrypoint is not linked or not enabled.
_Avoid_: auto-fix, install
