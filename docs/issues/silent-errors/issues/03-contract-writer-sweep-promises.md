# 03: contract the dead sidecar writer, keep the reader, sweep the promises

**What to build:** with both writers gone, the child can no longer write a failure sidecar —
and the code should say so rather than keeping a writer nothing calls. The failure arm of the
sidecar writer and the settle union it speaks in are deleted together with the tests that
pinned their byte shape. The *reader* is untouched: a `{"type":"failed",reason[,message]}`
payload, whoever wrote it, still classifies exactly as before, installed builds included.

The last of the old promises are swept out of the repo: no doc, comment, tool message or
smoke comment claims the orchestrator learns that a child errored, or that a refused spawn is
reported, or that a failure sidecar is what holds a batch. Then the whole suite is run for
real, all three smoke modes included.

**Blocked by:** 01, 02 — a writer can only be deleted once no path writes it.

**Status:** ready-for-agent

- [ ] No child-side path can write a `failed` payload; the writer's failure arm and the settle
      union are gone, along with the unit tests that only pinned their byte shape.
- [ ] The sidecar reader is unchanged: `failed` with and without `message`, malformed payloads,
      `done` with and without a result, and the exit-code and vanished-pane paths all keep
      their existing tests and outcomes.
- [ ] A repo-wide sweep finds no remaining claim that an error, a refusal, or a failed settle
      reaches the orchestrator; the surviving deliberate statements are the ones describing the
      hold and the escape hatches (report, `/quit`, close the pane).
- [ ] `npm run typecheck`, `npm test`, and `npm run smoke:provider-error` in every mode run for
      real, and the results are reported as they came out.
