# 01: Widen the pane seam into a Supervisor

**What to build:** Every spawn goes through one supervision seam — open a child, learn when its wait is over, stop it, close it — and a pane host becomes one kind of supervisor beside nothing else yet. Herdr and Rex children keep being opened, watched, interrupted and closed exactly as they are today. This is the change that makes the change easy: the seam is verifiable on its own, and both pane hosts stay green while the plain-terminal kind is built on it. No user-visible behaviour changes.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Herdr and Rex registration, spawn, layout, rename, reports, Esc interrupt and close behaviour are unchanged.
- [ ] Every existing pane-host test passes without modification.
- [ ] The seam carries host detection, the capability probe, opening a child, a liveness signal, stopping a child, and closing a child.
- [ ] Pane-only operations — layout read, resize, rename, focus, relay-interrupt-by-typing-Esc — are reachable only through the pane-host kind, not through the supervision seam.
- [ ] The pane-host adapter is wrapped for conformance rather than rewritten; its operations and behaviour are untouched.
- [ ] No call site outside the seam inspects a host's environment variables or speaks a host's CLI.
- [ ] Waiting, report reading, reminding and batch result assembly remain shared code, not per-kind branches.
- [ ] No plain-terminal behaviour, no new registration path and no new spawn recipe is introduced by this ticket.
