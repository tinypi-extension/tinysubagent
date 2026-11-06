# 01: Skip spawns with Labels already in use

**What to build:** The `subagent` tool skips requests whose effective Label matches a currently running subagent managed by this extension instance. It reserves Labels against overlapping calls, releases them when subagents stop running, and continues with non-duplicate requests. Skips are identified in the acknowledgment, excluded from routing, and treated as informational—including when every request is skipped. The TUI renders an all-skipped notice as non-error text. Existing within-Batch suffixing and normal spawn behavior remain intact.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Duplicate detection uses exact, case-sensitive matching of each request's effective Label, including the existing Role-derived default when no Label is provided.
- [ ] Duplicate checks include subagents started by earlier calls that are still running in this extension instance.
- [ ] A Label is reserved as soon as its Spawn is accepted, preventing overlapping calls from starting another subagent with the same effective Label.
- [ ] A reserved Label is released whenever its subagent is no longer running, regardless of outcome.
- [ ] Duplicate requests are skipped before routing or other per-request preparation; non-duplicate requests in the same Batch proceed normally.
- [ ] The acknowledgment identifies each skipped Label and reports normally started subagents and existing failures.
- [ ] Skipping is not a tool error, including when all requests are skipped; the TUI renders the all-skipped notice as informational text.
- [ ] Existing within-Batch Label suffixing, spawn acknowledgments, failure reporting, and result delivery remain intact for non-skipped requests.
- [ ] Tests verify externally observable behavior for mixed and all-skipped Batches, cross-call reservation and release, matching semantics, routing exclusion, and informational TUI rendering.
