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

**Status:** resolved

- [x] No child-side path can write a `failed` payload; the writer's failure arm and the settle
      union are gone, along with the unit tests that only pinned their byte shape.
- [x] The sidecar reader is unchanged: `failed` with and without `message`, malformed payloads,
      `done` with and without a result, and the exit-code and vanished-pane paths all keep
      their existing tests and outcomes.
- [x] A repo-wide sweep finds no remaining claim that an error, a refusal, or a failed settle
      reaches the orchestrator; the surviving deliberate statements are the ones describing the
      hold and the escape hatches (report, `/quit`, close the pane).
- [x] `npm run typecheck`, `npm test`, and `npm run smoke:provider-error` in every mode run for
      real, and the results are reported as they came out.

## Answer

Implemented on `integration/silent-errors` (`d9a7d0e`, merged `e3cd484`; review fixes
`e5dc969`, merged `8418662`).

`src/children/report.ts` now exports only `writeResultReport`, which can emit
`{"type":"done","result":…}`; `ChildSettle` and `writeReportFile` are deleted. The reader
(`watcher.ts`) and its tests are untouched — `failed` payloads, with and without `message`,
still classify exactly as before, and their comments now describe them as older-build/agy
input. The misnamed/unreachable failure-shape tests were deleted with their subject.

The promise sweep covered `GLOSSARY.md`, `AGENTS.md`, `report.ts` docs, `child.ts`,
`steer.ts`, `watch-batch.ts`, and both `docs/issues/report-required/spec.md` (now
`superseded in part`) and `docs/issues/report-tool/spec.md` (stale refusal/input-hook
paragraph replaced). "No child-side path can write a `failed` payload" is satisfied for the
pi child: the two remaining writers are the agy launch wrapper's post-exit
`failed/no-output` stamp and `spawnOne`'s missing-binary stamp, both explicitly out of
scope per the spec's Files table (line 150, "not changed") and "Out of scope: agy
behaviour" (line 165). They are documented as exceptions in `report.ts` rather than denied.

Verified on the merged tip: `npm run typecheck` clean; `npm test` 420/420;
`smoke:provider-error` default/`--retries`/`--no-auth` all PASS; `npm run smoke` PASS; the
failed/refusal-reporting grep returns only an unrelated herdr resize message.
