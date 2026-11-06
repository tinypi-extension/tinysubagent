# Avoid duplicate running subagent labels

Status: ready-for-agent

## Problem Statement

An orchestrator can request a subagent with a Label that is already used by a running subagent. The tool does not track active Labels, so it may start another subagent with the same Label, making panes, acknowledgments, and reports difficult to distinguish.

## Solution

Before routing or preparing spawns, the subagent tool checks requested effective Labels against Labels reserved by currently running subagents managed by this extension instance. It skips only duplicate requests and returns an informational notice identifying each already-running Label. Other requests in the Batch proceed normally. A skipped request is not a tool error, including when every request is skipped; the TUI presents the all-skipped notice as informational text.

## User Stories

1. As an orchestrator, I want a spawn request to be skipped when its Label is already running, so that active subagents remain distinguishable.
2. As an orchestrator, I want duplicate checks to use exact, case-sensitive Label matching, so that distinct Labels remain available.
3. As an orchestrator, I want an omitted Label to use the existing default derived from the Role for duplicate checking, so that default-labeled spawns are protected too.
4. As an orchestrator, I want matching to consider subagents managed by this extension instance across earlier tool calls, so that duplicate prevention is not limited to one Batch.
5. As an orchestrator, I want a Label to be reserved as soon as a spawn is accepted, so that overlapping tool calls cannot start concurrent subagents with the same Label.
6. As an orchestrator, I want a reserved Label released when its subagent is no longer running, so that I can reuse the Label later.
7. As an orchestrator, I want a Label released regardless of whether the subagent completes, fails, is cancelled, or otherwise stops running, so that stale reservations do not block future work.
8. As an orchestrator, I want only the duplicate request skipped in a mixed Batch, so that unrelated requested work can still start.
9. As an orchestrator, I want duplicate requests identified before routing or preparing their Briefs, so that skipped work consumes no unnecessary processing and is not routed.
10. As an orchestrator, I want the returned notice to identify the already-running Label, so that I understand why the requested spawn did not occur.
11. As an orchestrator, I want the acknowledgment to report both started subagents and skipped Labels in a mixed Batch, so that I have a complete account of the call.
12. As an orchestrator, I want an all-skipped call to return a successful informational response rather than a tool error, so that duplicate prevention is treated as an expected outcome.
13. As an orchestrator, I want an all-skipped notice rendered as non-error text in the TUI, so that expected skips are not presented as failures.
14. As an orchestrator, I want existing within-Batch Label suffixing behavior preserved, so that requests sharing a base Label within one call continue to receive distinct effective Labels.
15. As an orchestrator, I want existing spawn acknowledgments, failure reporting, and result delivery to remain unchanged for requests that are not skipped, so that duplicate prevention does not disrupt normal delegation.

## Implementation Decisions

- The canonical domain term is **Label**: the short name attached to a Spawn so its pane, acknowledgment, and result can be distinguished. Use this term rather than “name” in user-facing specification and domain language.
- Duplicate checks compare each request’s effective Label: its explicit Label, or the existing Role-derived default when omitted. Comparison is exact and case-sensitive.
- A duplicate is a Label currently reserved by a subagent managed by this extension instance. This does not attempt global uniqueness across unrelated extension instances or external panes.
- The existing within-Batch suffixing behavior remains in place. Duplicate detection uses the effective Label after that behavior has assigned unique Labels within the Batch.
- A Label is reserved once a Spawn is accepted, before another overlapping tool call can pass the duplicate check. Reservation is removed when the subagent’s wait settles, irrespective of outcome.
- Duplicate filtering occurs before routing and other per-request preparation. Remaining requests continue through existing validation, routing, and spawning behavior.
- The existing tool response communicates skipped Labels as informational acknowledgment content. Skipping does not add a tool failure; an all-skipped response is successful and the TUI renders it as non-error content.
- For mixed Batches, the acknowledgment contains the existing started entries and a notice for each skipped Label. Existing failures remain reported through the existing failure channel.
- No glossary or ADR changes are required: the established glossary already defines Label, and no applicable ADR was found.

## Testing Decisions

- Tests should assert externally visible tool behavior, not the data structure or internal reservation mechanism used to track running Labels.
- Use the existing `subagent` tool execution seam to verify a duplicate is skipped with an informative Label-specific notice, and that non-duplicate requests in the same Batch still spawn.
- Verify duplicate checks span separate calls while a subagent remains running; verify the Label becomes available after the subagent is no longer running.
- Verify the exact, case-sensitive comparison and effective-Label behavior, including the Role-derived default and preserved within-Batch suffixing.
- Verify duplicate requests are excluded from routing/preparation, without asserting implementation details beyond the observable absence of routing for skipped work.
- Verify mixed and all-skipped outcomes, including successful tool status and acknowledgment content.
- Verify the existing TUI result rendering displays an all-skipped notice as informational rather than error-colored content.
- Prior art: existing `subagent` tool tests exercise execution output and error semantics; existing acknowledgment and presentation tests cover rendered tool output. Extend these behaviors at the highest existing tool-execution seam, adding only the rendering assertion needed for the all-skipped presentation.

## Out of Scope

- Enforcing Label uniqueness across separate extension instances, processes, or panes not managed by this extension instance.
- Changing the existing within-Batch suffixing policy.
- Preventing duplicate Roles when their effective Labels differ.
- Changing the definition of when a subagent is considered running or changing its outcome/report lifecycle.
- Modifying result delivery, routing policy, spawn limits, or pane layout beyond excluding skipped requests from those existing flows.
