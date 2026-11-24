# Spec: a plain terminal is a supervisor too

Status: resolved

Spec approved in session with the user; every decision below is a decision, not a proposal.
Vocabulary follows `GLOSSARY.md` (`Supervisor`, `Plain terminal`, `Live line`, `Pane host`,
`Outcome`, `Never started`, `Hold open` — all added or relaxed by this change).
ADRs written alongside: `0004-panes-are-one-supervisor.md`, `0005-a-plain-terminal-child-cannot-be-steered.md`.

## Assumptions I'm making

1. A pane host and a plain terminal are mutually exclusive **per pi process**, decided once at
   registration from the environment. There is no session that is both.
2. `pi`'s non-interactive modes keep the whole agent loop: tools registered by an `-e` extension
   still execute, and `agent_settled` / `session_shutdown` still fire. Verified against the
   installed pi (v1.5.2) docs and by running a probe extension tool in `--mode json`.
3. The child's session record is written per finished message, never per delta, so a child's
   in-flight text is observable **only** on its stdout. Verified in pi's session-manager.
4. Non-zero exit and a `failed` report are both authoritative; neither is preferred over the
   other, and a batch may contain both.

→ Confirmed at approval.

## Problem Statement

Tinysubagent only exists where a pane host does. In a plain terminal — a bare `pi` in iTerm,
a CI shell, an SSH session, `tmux` without herdr — the extension refuses to register the
`subagent` tool at all, and the orchestrator is told nothing about why. The whole delegation
layer is missing exactly where a quick parallel lookup would be most useful, and the user has
to know that herdr or Rex is installed before they can even discover the feature.

The features that made the tool pane-shaped are also the ones a plain terminal cannot honour.
A child's pane is where a human watches it, steers it, reads a crash, and stops it. None of
that exists without a pane, so a naive "just don't open the pane" version would leave a user
staring at a frozen call with no idea whether four subagents are working or hung, and would
lose every failure message that used to scroll past in the child's pane.

## Solution

A plain terminal becomes a supervisor in its own right: with no pane host detected, every
child runs as its own headless process, and the call still blocks and still returns one report
per child.

Because nobody can watch a pane, the tool draws up to four **live lines** — one per child,
refreshed while the batch runs, each showing the child's role, label, elapsed time and the tail
of the text it is streaming. Because nobody can read a failure off a pane, the failure evidence
moves into the report: a child that exits non-zero carries its exit code and the last lines of
its stderr, and a child that never started carries the remedy that used to be implied by "the
pane is still open". Because nobody can steer a child, a plain-terminal child cannot be typed
at; the operator's only control is the interrupt, which stops the batch by killing the children
rather than by closing panes.

Under a pane host nothing changes. Herdr and Rex keep their panes, their layout, their steering,
their hold-open and their `cancelled` outcome.

## User Stories

1. As a user running `pi` in a plain terminal, I want the `subagent` tool to be registered, so
   that delegation works without installing a pane host.
2. As a user running `pi` in a plain terminal, I want a batch to return every child's report in
   the one tool result, so that I do not have to poll for it.
3. As a user running `pi` in a plain terminal, I want to see up to four live lines while the
   batch runs, so that I know the children are working rather than hung.
4. As a user, I want each live line to name the child's role, label and profile, so that I can
   tell which child is which without a pane to look at.
5. As a user, I want each live line to show how long that child has been running, so that I can
   judge whether it is stuck before the call returns.
6. As a user, I want each live line to show the tail of the text that child is writing, so that
   the wait shows real progress instead of a spinner.
7. As a user, I want the live lines to be replaced by the report when the call returns, so that
   transient progress does not pollute the finished result.
8. As a user, I want the live lines to survive a slow child without freezing the child, so that
   rendering progress never stalls the subagent's own stdout.
9. As a user, I want a child that reports successfully to come back with its report, exactly as
   it does under a pane host, so that plain terminal is not a degraded delegation mode.
10. As a user, I want a child that exits non-zero to be reported as failed with its exit code, so
    that I can tell a crash from a refusal without a pane to read.
11. As a user, I want a failed child's last stderr lines included in its report, so that the real
    cause reaches me instead of "exit 1".
12. As a user, I want a child that reports a failure to come back as failed, so that the two
    routes to failure — a report and an exit code — read the same way.
13. As a user, I want a child that pi never started to be reported as never started, with the
    remedy spelled out in the report, so that a missing login is actionable without a pane left
    open for me to log in at.
14. As a user, I want a child that finishes without reporting to be reminded and then completed
    with no summary, so that plain terminal behaves like the pane hosts do.
15. As a user, I want an interrupt to stop the batch at once, so that I can stop work from where
    I am rather than visiting each child.
16. As a user, I want an interrupt to kill the children's whole process groups, so that a child's
    own tool subprocesses do not survive the batch as orphans.
17. As a user, I want an interrupted plain-terminal child to report no summary, so that half a
    report is never read as a report.
18. As a user running a batch under herdr or Rex, I want every one of today's behaviours
    preserved — panes, layout, resizing, steering, hold-open, `cancelled` — so that adding plain
    terminal support costs me nothing.
19. As a user, I want herdr or Rex to win whenever one is detected, so that installing a pane host
    still gives me the richer experience.
20. As a user whose herdr is detected but whose plugin is not linked, I want the existing
    readiness problem and one-step fix, so that a broken pane host is never silently downgraded
    to a headless run.
21. As a model orchestrator, I want the tool description and prompt snippet to describe what will
    actually happen, so that I do not promise the user a pane that will not open.
22. As a model orchestrator running in a plain terminal, I want agy-backed profiles hidden from the
    profile list I am offered, so that I do not pick a profile that cannot run here.
23. As a model orchestrator running in a plain terminal, I want an explicit request for an
    agy-backed profile refused with the reason, so that a hidden profile never becomes a silent
    no-op.
24. As a user, I want agy-backed profiles still listed and editable in the settings UI, so that
    configuring them for a herdr session still works.
25. As a model orchestrator, I want routing to consider only profiles that can run here, so that
    a classifier never routes a plain-terminal batch into a profile that cannot start.
26. As a user, I want a single child batch to draw one live line and a four-child batch to draw
    four, so that the view matches the batch rather than the terminal size.
27. As a user, I want a batch of children with different harnesses to fail only the children that
    cannot run here, so that one unavailable profile does not sink the whole call.
28. As a user, I want the tool to work on a machine where no pane host is installed at all, so that
    the extension has no pane-host dependency to install before first use.
29. As a user, I want a plain-terminal child to inherit the same environment, direnv prefix,
    launch prefix, session file and tool list as a pane-host child, so that only the supervision
    differs.
30. As a maintainer, I want one seam that every spawn goes through, so that a third supervision
    style does not need a third branch in the spawn path.
31. As a maintainer, I want the pane-host adapter to remain unchanged, so that this change is
    additive to the supervision seam rather than a rewrite of herdr and Rex.
32. As a maintainer, I want the registration gate to keep living in one place, so that register-or-
    not stays a single decision rather than a condition smeared across call sites.

## Implementation Decisions

### The supervision seam

`PaneHost` is the wrong name for what the spawn path actually needs. What it needs is to open a
child, learn when the wait is over, stop it, and clean up. Those four things are a **Supervisor**,
and a pane host is one implementation of it.

- A new `Supervisor` seam carries: `open`, `ended` (a liveness signal), `stop` (the interrupt),
  `close`, plus the existing detection and capability probe.
- Panes become one supervisor kind. The existing pane-host adapter keeps its operations and its
  behaviour, and gains a thin conformance wrapper rather than being rewritten.
- A second supervisor kind — the plain-terminal one — opens a child as a process rather than a
  pane. It has no notion of layout, renaming, focus or pane existence, and it must not pretend
  to: those operations are absent from the pane-visible interface, not stubbed to throw.
- Pane-only operations (layout, rename, resize, relay-an-interrupt-by-typing-Esc) stay behind the
  pane-host adapter and are reached only when the chosen supervisor is a pane host.
- The behaviour that differs between the two kinds lives in **one** place: the per-kind spawn
  recipe. Everything downstream — waiting, report reading, reminding, the batch result — is
  shared and stays shared.

### What a plain-terminal child is

- The same launch wrapper as today: same environment resolution, same direnv / launch-prefix
  handling, same session file, same tool list, same role brief. Only how it is started and
  watched differs.
- The child is started with **no pty** and piped stdio, in pi's JSON event mode — explicitly, as
  an argv decision, not as a side effect of not having a tty. Pane hosts keep the interactive
  argv untouched.
- stdout is drained continuously and never synchronously; the live view is derived from the JSON
  events on that stream, coalesced rather than redrawn per delta.
- stderr is buffered in a bounded ring (last 20 lines), attached to the report only when the
  child fails.
- The wrapper's exit-code sidecar is retained as the authoritative ending signal.
- Hold-open is dropped for this kind: with no tty the wait for a keypress returns immediately,
  and there is nobody to read the pane.

### What ends a wait in a plain terminal

- The wait ends on a report, or on process exit, whichever comes first.
- A child that exits zero with no report is the existing content-free completion — no summary, and
  no lingering process.
- A child that exits non-zero with no report is `failed`, carrying the exit code and the stderr
  tail.
- A report that declares failure is `failed` on the same footing.
- The `cancelled` outcome is not reachable here. It says "the pane went unexpectedly", which is a
  statement about a pane; a process that dies is learned from its exit code.
- The `never started` classification is kept, and its remedy is rewritten from "the pane is left
  open" into an instruction the orchestrator can act on.

### Interrupt

- An orchestrator interrupt in a plain terminal sends a termination signal to each child's process
  group, then a kill signal after a short grace (5s), so tool subprocesses die with the child.
- The outcome is `interrupted` with no summary, matching the pane behaviour minus the close.
- Nothing is salvaged from a stopped turn.

### Live lines

- The subagent tool's partial-update channel drives the view: up to four lines, one per child,
  each replaced as the child streams, and each cleared when the batch result arrives.
- A line shows role, label, elapsed time, and the last line of the child's streamed text,
  truncated to the available width. No scrolling region and no spinner.
- The ack line is what a live line opens with, so a spawn is acknowledged even when a wait
  follows; this is the one pane-host rule (`drawn only when no wait follows`) that does not carry
  over.
- Redraws are coalesced on a ~250ms cadence off the draining reader, never in the delta handler.

### Failure evidence

- The stderr tail is a report field: a new failure detail carried alongside the exit code, drawn
  only for a child that failed.
- A `never started` child's report carries the remedy text rather than a pane reference.

### Registration and gate

- The tool registers whenever the extension loads, in a plain terminal or under a pane host.
- Detection is unchanged and still decides *which* supervisor: a detected pane host wins; a
  detected-but-unready pane host keeps its readiness problem and its one-step fix and never falls
  back; "plain terminal" means exactly "no pane host detected".
- The never-installed case therefore needs no install step: the plain-terminal supervisor has no
  external dependency.

### Profiles and prose

- Profile ordering gains a mode input: profiles whose harness cannot run in the current
  supervision mode are filtered out of what the model is offered, which removes them from the
  profile list, from routing candidates, and from the unknown-name error together.
- `current` is never affected, so the offered list may legitimately be just `current`.
- A direct request for a filtered profile is refused with a reason naming the pane-host
  requirement, rather than ignored.
- The settings UI still lists and edits every configured profile regardless of mode.
- Tool description and prompt snippet become mode-aware only where a plain terminal makes them
  false: the pane in the snippet, and the pane/layout narration. Pane-host prose is unchanged when
  a pane host is present.
- The reminder loop for an unreported settle needs no change: it is driven from the settle hook and
  works in a non-interactive run.

### Documented trade-off

Two ADRs are written. `0004` records that panes are one supervisor and that the seam is
supervision, not panes. `0005` records that a plain-terminal child cannot be watched, steered, or
read off a screen, so its failure evidence moves into the report, its stop becomes a kill, and its
progress has to be synthesised from its own event stream.

## Testing Decisions

A good test here drives a user-visible outcome — what the orchestrator gets back, what a live line
says, whether a process was killed — through a seam, and asserts on that outcome. It does not
assert that a particular module called a particular private helper, and it does not restate an
implementation line.

**One new seam, two reused.**

1. **New: the Supervisor seam.** Every test of the new behaviour drives `execute` with an
   in-memory supervisor that records its calls and hands back scripted reports, exits and stderr,
   so no test spawns a real child process. Both kinds are exercised through it: the pane-host fake
   proves nothing regressed, and the plain-terminal fake proves the new wait, kill, completion and
   failure routes. Highest seam available, and it is the seam the feature is built on.
2. **Reused: the child-argv seam.** The plain-terminal command shape is a pure function of a spawn
   spec, tested as a pure function — the same way the pane-host argv is today. Prior art:
   `test/children/harness-pi.test.ts`, which already asserts what an adapter must and must not put
   in an argv.
3. **Reused: the registration seam.** The existing gate test that asserts *registers nothing outside
   a pane host* inverts into: registers under a pane host, registers in a plain terminal, and picks
   the pane host when one is detected. Prior art: `test/pi/extension.test.ts`.

Deliberately not tested: that a redraw is coalesced to 250ms (a timing constant, not a behaviour);
that stderr is kept in a 20-line ring beyond the fact that the tail reaches a failed report; and
anything that would only restate the spawn recipe.

Where a pane-only behaviour is now conditionally skipped — hold-open, `cancelled`, the pane
reference in a never-started remedy — the pane-host suite must still assert the old behaviour
unchanged, so the skip is proven additive rather than a quiet regression.

## Out of Scope

- **agy in a plain terminal.** agy-backed profiles are hidden there, not run. Its verdict arrives
  through a Stop hook, its transcript path is unknown up front, and its non-interactive semantics
  are unproven; agy stays pane-host only.
- **Steering a plain-terminal child.** There is no channel into a headless child, and nothing here
  adds one. Humans lose the ability to redirect a child mid-run and gain nothing to replace it.
- **A supervision-mode override.** No setting forces a headless batch inside herdr, and none forces
  a pane when no host exists. Auto-detection is the only input.
- **Persisting the live view.** Live lines are transient; the report is the record.
- **Any change to pane-host behaviour, layout, or the orchestrator-first rule.**
- **A progress channel for pane-host children.** Their pane is the view; nothing is streamed into
  the orchestrator for them.

## Further Notes

- This change relaxes one glossary invariant: *every live child owns a pane* becomes *every child
  supervised by a pane host owns one*. `GLOSSARY.md` now also carries `Supervisor`, `Plain
  terminal` and `Live line`, and has pane-only clauses on `Cancelled`, `Hold open`, `Never
  started`, `Interrupt`, `Outcome` and `Ack`.
- ADR `0001` (the blocking tool result) is untouched and still the reason a batch collects into one
  result. ADR `0002` (interrupt propagates) keeps its rule — an interrupt stops the whole batch — and
  this spec only replaces *how* a child is stopped when it has no pane.
- The plain-terminal supervisor is the first thing in this repo that reads a child's stdout. Today
  stdout is entirely ignored, which is why switching that stream to JSON events costs nothing.
- A pane host being present but unready stays an error with a fix. If users later want to force a
  headless batch from inside herdr, that is a separate change with its own setting.

Tickets: `issues/01`–`07`. Implemented on `plain-terminal`, seven tickets, then one review-fix commit (`3635147`) closing nine defects the two-axis review found — a turn-end report that still promised a pane, a plain wait that could hang on a killed wrapper, a scraped summary that should not exist without a pane, a `stop` that missed a lingering process group, glossary rows still asserting every child owns a pane, two stale gate comments, an optional member that was always implemented, a per-batch leak for pane-less children, and a detached-process comment that overclaimed.
