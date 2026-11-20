# Spec: Rex as a pane host

Status: ready-for-agent

## Problem Statement

I use Rex as well as herdr, but the subagent extension only exists when pi runs inside herdr. In a Rex block the tool does not register, so I cannot delegate a batch: no child blocks open, no labels appear, no reports come back, and there is no way to interrupt the batch from my terminal. The extension's setup instructions, capability probe, spawn recipe, layout planner, interrupt relay and watcher all speak only herdr. Even the glossary says a pane is something herdr manages.

This is not a missing command; it is a missing pane host. Rex already has the primitives the extension needs — `split`, `block rename`, `block close`, `send-key esc`, `window inspect --json`, and a `session.resize_pane` API — but the extension has no way to use them.

## Solution

Introduce one pane-host abstraction with a herdr adapter and a Rex adapter. Auto-detect the pane host from the environment when pi starts: herdr from its pane ID, socket and environment marker; Rex from its block, session and server variables. Herdr wins when both sets are present, so today's behavior is preserved. The settings command stays available everywhere; the subagent tool registers once a capability probe passes for the detected host.

For Rex, keep the host-neutral spawn recipe and hand its generated wrapper script to `rex split --json` with a label, cwd, ratio, `--focus=false` and `--keep-open`. Take the new block's full ID from the JSON result. All Rex commands pin the captured session and server, and address children by full block IDs, so a focus change cannot redirect them. Port the orchestrator-first layout intent to Rex using window geometry from session inspection and the ratio-based resize API. Relay interrupts with Esc on both hosts. Keep the sidecar-driven wait exactly as it is: sidecars carry reports and exit codes, the Rex CLI is used only to detect a vanished block and to close blocks after an outcome.

Update the glossary, README and package description to speak of pane hosts rather than herdr alone. Do not add a Rex plugin step, a config toggle, a version gate, a new ADR or a committed live-Rex integration test.

## User Stories

1. As a pi user inside herdr, I want the subagent tool to keep working exactly as it does today, so that installing Rex support does not change my workflow.
2. As a pi user inside a Rex block, I want the subagent tool to register, so that I can delegate work without switching pane hosts.
3. As a pi user outside both herdr and Rex, I want no subagent tool to appear, so that the tool surface stays honest about what it can do.
4. As a pi user with both herdr and Rex environment variables set, I want herdr to win, so that an existing herdr session is not hijacked by a nested Rex context.
5. As an orchestrator in Rex, I want one child block opened per subagent in a batch, so that each child has its own live terminal.
6. As an orchestrator in Rex, I want each child block labelled with the child's name, so that I can see at a glance which block belongs to which subagent.
7. As an orchestrator in Rex, I want the child block to start in the requested working directory, so that relative paths in the brief mean the same thing as they do in herdr.
8. As an orchestrator, I want the generated wrapper script to be the command passed to Rex's split command, so that PATH, configuration variables, model arguments and sidecar paths survive unchanged.
9. As an orchestrator, I want the child's block ID read from the split command's JSON result, so that I never guess an ID from a label or a truncated suffix.
10. As an orchestrator, I want the split to leave focus on my own block, so that watching one child does not move me away from the orchestrator.
11. As an orchestrator, I want the child block kept open after its wrapper exits, so that close timing and crash inspection stay explicit and match herdr.
12. As a Rex user, I want no plugin link or enable step, so that setup is just having pi in a Rex block and `rex` on PATH.
13. As a Rex user, I want the capability probe to accept my block and session context plus a reachable `rex` command, so that I get the tool without an arbitrary version gate.
14. As a herdr user, I want the existing plugin fix still offered when my pane entrypoint is not linked or enabled, so that herdr repair behavior is unchanged.
15. As a Rex user, I want no herdr plugin fix suggested to me, so that I am not told to repair something Rex does not have.
16. As an orchestrator in Rex, I want every Rex command pinned to the session and server captured from my environment, so that changing the app's focus mid-batch cannot redirect a rename, resize, key send or close.
17. As an orchestrator in Rex, I want children addressed by full block IDs, so that a label collision or shared ID suffix cannot target the wrong block.
18. As an orchestrator, I want the first child in a Rex window to split to the right with the orchestrator keeping three fifths of the width, so that Rex matches the herdr orchestrator-first layout.
19. As an orchestrator, I want later children appended below the bottom-most live sub-block, so that the child column grows downward just as it does in herdr.
20. As an orchestrator, I want the child column re-balanced as children are added and removed, so that no child becomes a sliver.
21. As an orchestrator, I want a boundary I have personally dragged to be preserved on later spawns, so that my manual adjustment is not silently reset.
22. As an orchestrator, I want layout reads to come from Rex's session inspection and writes to use its ratio-based resize API, so that the same layout planner works on normalized geometry from either host.
23. As a maintainer, I want layout calculation kept pure and host adapters responsible for I/O, so that placement rules can be tested without opening real blocks.
24. As an operator, I want pressing Esc in my orchestrator block to interrupt the whole live batch in Rex, so that stopping work feels the same on both hosts.
25. As an operator, I want the interrupt to reach each child block by ID rather than by focus, so that a focused child does not absorb the key while others keep running.
26. As an operator, I want interrupted children's blocks closed, so that my Rex window is not left full of dead panes.
27. As an orchestrator, I want each child's report and exit code still delivered through its sidecars on Rex, so that the blocking batch contract is identical.
28. As an orchestrator, I want a Rex child whose block has vanished before reporting to be recorded as cancelled, so that a batch always ends with an outcome for every child.
29. As an orchestrator, I want successful, failed, interrupted and cancelled children to have the same close behavior on Rex as on herdr, so that I do not need host-specific cleanup habits.
30. As a user with custom launch settings, I want the existing launch-script, direnv and launch-prefix environment names to keep working, so that upgrading does not break my configuration.
31. As an orchestrator, I want the same settings command and the same batch size limit on Rex, so that selecting roles, profiles, models and child counts is unchanged.
32. As an orchestrator, I want the same tool description and report format on Rex, so that I do not need a different prompt for a different pane host.
33. As a maintainer, I want host-specific behavior behind one interface, so that spawn, watch, interrupt, capability and registration code never branch on the current host.
34. As a maintainer, I want herdr tests left untouched and new Rex tests added beside them, so that regressions are visible on either side.
35. As a maintainer, I want a fake `rex` CLI at the command boundary to be the test seam, so that I can verify arguments and JSON handling without a live Rex app.
36. As a reviewer, I want no new ADR for the adapter or ratio layout, so that architecture docs stay reserved for surprising, hard-to-reverse decisions.
37. As a reader, I want the README to say the tool works in herdr or Rex and list the Rex prerequisites, so that I can set it up without reading source.
38. As a reader, I want the glossary to define pane host, pane and block consistently, so that host-neutral docs do not contradict each other.
39. As a user, I want any live smoke test that creates or closes real Rex blocks to require my permission, so that my current Rex workspace is not changed without asking.
40. As a user, I want a two-child batch in Rex to return both reports, so that I know the host change actually delivered the feature.

## Implementation Decisions

- Add a pane-host abstraction that exposes host detection, capability readiness, opening a child pane, renaming a child pane, closing a child pane, reading layout geometry, rebalancing layout and relaying an interrupt. Implement it once for herdr and once for Rex. Existing herdr behavior is preserved behind its adapter; call sites use the interface and do not inspect environment variables themselves.
- Detect the host from the environment at extension load. Herdr requires its environment marker, pane ID and socket path. Rex requires its block ID and session ID, with the server ID used when present. Herdr has precedence when both are set. No config toggle or forced-host override is added.
- Keep the settings command registered in every context. Register the subagent tool only when a detected host passes its capability probe. With neither host detected, registration behavior stays as it is today.
- Make the Rex capability probe require the Rex context variables and a reachable `rex` command. Do not impose a minimum Rex version yet. Do not offer a Rex repair fix; the plugin fix remains herdr-only and is described that way in the glossary.
- Use the existing host-neutral spawn recipe to generate the wrapper script. For Rex, pass that script as the command to a split invocation that requests JSON output, a label, the child's cwd, a birth ratio, no focus change and keep-open. Parse the JSON result for the new full block ID. Do not build a Lua script or type commands into a shell.
- Preserve the existing launch-script, direnv and launch-prefix environment variable names. Rex does not need the launch-script variable because the wrapper is the split command, but the other knobs remain shared with herdr.
- Pin all Rex commands to the captured session, and to the captured server when present. Use full block IDs for every child-targeted command, including rename, resize, key send and close.
- Keep the layout planner pure and host-neutral. Feed it normalized geometry from Rex's session inspection. At column birth, split right so the new child receives two fifths and the orchestrator keeps three fifths. Append later children below the bottom-most live sub-block. Express boundary adjustments through Rex's ratio-based pane resize operation using the two adjacent block IDs and the desired direction. Treat a resize failure as a best-effort warning, not a failed spawn.
- Keep interrupt semantics identical: Esc is the key sent to live child panes on both hosts. For Rex, send Esc to each child block by ID. Interrupting closes the blocks that were stopped, matching herdr. Do not introduce Ctrl-C for Rex.
- Keep the sidecar-driven wait and outcome rules unchanged. Reports and exit codes come from files. The Rex CLI is used only for block liveness checks that distinguish a vanished block from a normal exit, and for closing blocks after an outcome. A vanished block produces the same cancelled outcome as a vanished herdr pane.
- Keep the current orchestration contract unchanged: blocking tool result, batch size limit, settings schema, roles, profiles, classifiers, nested-delegation ban and report format all stay as they are. This follows the existing ADR about blocking results and needs no new ADR.
- Update the glossary so pane host names the kind of TUI, pane is host-neutral, block is Rex's pane, capability probe covers either host, and plugin fix is explicitly herdr-only. The glossary stays a vocabulary list, not an implementation document.
- Update README and package metadata to describe both hosts, including Rex prerequisites (`REX_SESSION`, `REX_BLOCK`, `rex` on PATH) and the absence of a plugin link.
- Test at one seam: the pane-host command boundary. Fake the herdr CLI as today and add a fake `rex` CLI that accepts the same command surface. Assert externally visible behavior — commands issued, arguments, JSON parsed, and resulting orchestration outcomes — rather than internal helper calls.

## Testing Decisions

- A good test here exercises the host adapter from outside: call the host-neutral operation with a fake CLI on PATH and assert the command that would be sent to the pane host and the outcome returned to the orchestrator. It should not assert private helper calls, internal state shapes or generated script bodies beyond their externally observable path and arguments.
- The chosen seam is the existing command boundary used by the herdr fake CLI. Reuse that seam rather than inventing a mock framework. Add a fake `rex` CLI beside it, covering split, rename, close, send-key, block inspection and session inspection, with JSON fixtures for block IDs and layout rects.
- Test host detection and registration: herdr context registers herdr; Rex context registers Rex; neither context leaves the tool unregistered; both contexts prefer herdr. Keep the existing herdr registration tests unchanged.
- Test the Rex capability probe: pass when context and CLI are available; fail with a useful problem when the CLI cannot be reached; never offer a plugin fix. Keep herdr version-gate and plugin-fix tests unchanged.
- Test the Rex spawn command contract: label, cwd, ratio, no focus change, keep-open, JSON output, wrapper script as the command, and full block ID extracted from JSON. Keep the existing spawn recipe tests unchanged.
- Test layout with normalized geometry fixtures: first split goes right with the orchestrator at three fifths; later children append below the bottom-most live sub-block; resize calls use the correct adjacent block IDs, direction and ratio; a drifted boundary is preserved; a failed resize is non-fatal.
- Test interrupt relay: Esc is sent to every live child block by full ID, and interrupted children are closed. Do not test for Ctrl-C.
- Test wait and outcome behavior: reports still come from sidecars; a normal child exit closes its block; a vanished block becomes cancelled; all four report outcomes keep herdr's close semantics.
- Test docs-level contracts lightly: README and metadata mention Rex. Do not test prose wording exhaustively.
- Prior art: the existing fake-herdr CLI tests for spawn and interrupt, the pure layout planner tests, the watcher tests and the extension registration tests. New Rex tests mirror those shapes at the same seam.
- Do not commit a live-Rex integration test. Run the full test suite and type check after implementation. A manual smoke test that opens a two-child batch in a real Rex window is useful but must be approved first because it creates and closes real blocks.

## Out of Scope

- No config toggle, host override or auto-detection precedence change beyond herdr wins.
- No renaming or neutral aliasing of the existing launch-script, direnv or launch-prefix environment variables.
- No Rex plugin, plugin link, plugin enable step or repair fix.
- No Rex minimum-version gate.
- No Lua-based spawn path, shell-typed commands or direct Rex socket scripting.
- No new ADR; the pane-host adapter and ratio layout are reversible and visible in code.
- No committed live-Rex smoke test and no unapproved creation or closing of real Rex blocks.
- No changes to herdr behavior, herdr tests, the blocking tool-result contract, settings schema, roles, profiles, classifiers, batch size limit, nested-delegation ban or report format.
- No new user-facing settings fields and no changes to the tool's description beyond what is needed to mention both pane hosts.

## Further Notes

- Rex facts verified against the locally installed `rex` 0.1.0-preview.21 and the official CLI, shell-scripting and Lua references: split supports JSON output, label, cwd, ratio, focus, keep-open and a trailing command; JSON split results expose `.block_ids[0]`; block subcommands include rename, close, send-key and inspect; session inspection reports window layouts; `session.resize_pane` accepts a session ID, direction, before/after block IDs and a fraction, and does not change focus.
- The glossary was updated inline during domain modeling and should remain only a vocabulary list. No ADR was added during design review.
- Definition of done: herdr behavior and tests unchanged; in Rex, pi registers the tool, a two-child batch returns both reports, Esc interrupts and closes both blocks, and liveness and close outcomes match herdr; tests, type check and docs pass.
