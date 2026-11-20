# 02: Rex single-child batch returns its report

**What to build:** When pi runs inside a Rex block, the subagent tool registers and a one-child batch works end to end: the child block opens, carries the label and brief, reports through its sidecars, and closes after the outcome. No Rex plugin, version gate or config toggle is needed.

**Blocked by:** 01: Pane-host seam with herdr passthrough.

**Status:** resolved

- [x] In a Rex context with a reachable `rex` command, the tool registers; outside both pane hosts it does not; in herdr it still does.
- [x] The Rex capability probe requires the Rex block/session context and a reachable CLI, with no minimum-version gate and no plugin fix offered.
- [x] Herdr wins when both herdr and Rex context variables are present.
- [x] A one-child batch opens a labelled child block from the generated wrapper script, with the requested cwd, keep-open, pinned session/server and full block ID from the split JSON result.
- [x] The child's report and exit code still come from sidecars, and the report returns as the blocking tool result.
- [x] The child block closes after a report or session exit, matching herdr's outcome behavior.
- [x] Fake-`rex` CLI tests cover detection, readiness, split arguments, JSON block ID parsing, label, liveness, close and the returned report; herdr tests remain unchanged.
- [x] README and package metadata describe both pane hosts, the Rex prerequisites and the absence of a plugin link.
- [x] No real Rex blocks are created or closed during verification without explicit permission.

## Comments

- 2026-11-20: Implemented in `642e711` and earlier slice commits on `ticket/rex-02-single-child`: Rex detection/readiness, labelled split from the wrapper with pinned session/server and full block ID, block inspect/rename/close, and sidecar-backed single-child report plus close on report or clean exit. Fake `rex` CLI only; herdr path unchanged. `npm test` 546 pass, `npm run typecheck` clean; integration tip merged (already up to date).
