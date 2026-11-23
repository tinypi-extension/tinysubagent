# 02: Refuse a share that cannot be honoured

**What to build:** `shareContext: true` on a request that cannot be given the orchestrator's context
fails that request, with an error naming the reason, without opening a pane — and its siblings in the
same batch spawn exactly as they would have. The two cases: the request's profile resolves to the
`agy` harness (no session file to fork), and the orchestrator itself runs `--no-session` (no file to
fork from).

Silently spawning a clean child is the failure mode this ticket exists to prevent: the brief was
written as if the child knows things it does not.

**Blocked by:** 01 (a subagent can be given the orchestrator's context)

**Status:** ready-for-agent

- [ ] `shareContext: true` with an `agy`-profile request fails that request with an error naming the harness, and no pane opens for it
- [ ] `shareContext: true` when the orchestrator has no session file fails that request with an error naming that cause
- [ ] An unshared sibling in the same batch is unaffected by either refusal
- [ ] The refusal happens before the launch files are written, so no orphan fork file or script is left behind
