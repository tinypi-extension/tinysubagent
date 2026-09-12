# Plan: the report is the only clean ending

Implements `docs/spec-report-required.md` (approved). Repo `tinysubagent` @ `f5f24a5`.

**Baseline (verified):** `npm run typecheck` clean; `npm test` → 246 pass / 0 fail.

**Goal:** a `done` settle without a prior `subagent_report` writes no sidecar and does not
shut the child down — the pane stays open at its prompt and the batch holds until a human
asks for the report, quits the child, or closes the pane. Terminal set becomes: reported /
exited / failed / pane-closed.

## Decisions fixed by the spec

1. Orchestrator gets no notice while the batch is held — human-only resolution.
2. No config flag restores auto-close; callers (smokes, CI) fix their own tasks.
3. A settle with no assistant message (`failureDetail` → `no-output`) is also silent —
   same as `done`. Only an `error` stop reason still reports `failed`.

## Modules

| Module | Deliverable |
|---|---|
| R1 | `src/children/child.ts`: silent `done` and `no-output` settles; module doc + failed-write tool message rewritten; `_ctx` |
| R2 | `src/children/task-markdown.ts` + `src/children/spawn.ts`: remove the fallback promise; reword the nested-delegation rationale |
| R3 | Docs: `docs/intent.md` (line 45 amendment + silence paragraph), `docs/spec-report-tool.md` (status, legacy row, amended Never), `README.md` (nested bullet, Lifecycle 4) |
| R4 | `scripts/smoke.ts` tasks instruct the report call; `test/children/child.test.ts` inverted/added tests |
| R5 | Checkpoint: typecheck + full suite; archive the code-layout plan/todo; commit |

## Checkpoints

| Checkpoint | After | Expected |
|---|---|---|
| CP0 | — (have it) | 246 pass / 0 fail |
| CP1 | R1–R2 | typecheck clean; suite green with the inverted expectations |
| CP2 | R3–R4 | typecheck clean; suite green; no doc still claims the session-scrape fallback |
| CP3 | R5 | typecheck clean; `npm test` → all pass / 0 fail; one commit |

Real-child smokes (`smoke`, `smoke:tool`, `smoke:interrupt`, `smoke:provider-error`,
`smoke:layout`) need a live herdr and cannot run in this environment; the smoke task
changes are verified by reading, not by running.

## Boundaries

- **Never:** make the settle path close a pane again; leave the old fallback promise in a
  doc, comment, or tool message; weaken an existing test instead of rewriting it.
- **Ask first:** a steer notice to the orchestrator while waiting; any config switch.
