# Plan: a profile can choose the child CLI (pi or agy)

Implements `docs/issues/agy-harness/spec.md`. Companion checklist: `docs/issues/agy-harness/todo.md`.

**Status: spec approved, Q1-Q4 decided (2026-10-14). Do not start C1 or later until spike S0 is recorded in `spike.md`.** S4 (per-run hook scope) is a stop condition.

**Baseline:** repo `tinysubagent` @ `70f4c9e`. `npm run typecheck` clean. `npm test` → **423 pass / 0 fail** (~8 s). Only uncommitted file: `docs/issues/agy-harness/spec.md`.

**Goal:** one profile setting (`harness`) picks pi or agy, with the profile's own model and effort/thinking. An agy child runs in a herdr pane and ends with a report, a failure, or a pane held open for a human. Pi behaviour does not change.

## Decisions carried from the spec

- `harness` defaults to `pi`. Unknown value → profile dropped with a warning (fail closed).
- agy runs interactively (`-i`), never `-p`. The pane is the only human surface.
- Report uses the existing sidecar `$PI_TINYSUBAGENT_REPORT`. No new keys.
- Original agy settle path used a Stop hook (historical implementation); the approved project-cwd amendment removes it. Report sidecars now drive completion; no missing-report nudge.
- Hook scope is per run. Global agy config is never written.
- **Test model (testing blocker):** all real agy runs (S0, C10) use `gpt-oss-120b`. Unit tests stay stubbed and never call a model. Google's models page lists GPT-OSS-120b on Free, AI Plus, AI Pro, and AI Ultra, not Enterprise, and marks it for removal on **2026-11-02**. The real-run gate (C10) must pass before then, or the test model must be re-pinned. The exact `--model` string is not documented (the page shows a display name): S1 pins it from `agy` itself. `--effort` with this model is confirmed in S1 too.
- Tool allowlist (Q1): not a profile key. It is the role's `tools` frontmatter. On agy, a role with a non-empty `tools` list is refused at spawn (`spawn.ts`, before the pane opens). A role with no `tools` is allowed.
- Approval prompts (Q2): the human approves in the pane. No `--dangerously-skip-permissions` in v1.
- Exit 0 with no report (Q4): the agy wrapper writes `{"type":"failed","reason":"no-output"}` to the report sidecar before the exit sidecar, only if none exists. The watcher is unchanged and classifies it as `failed / no-output`.
- Not changed: `watcher.ts`, `report.ts`, `herdr/*`, `herdr-plugin/*`, `present/*`, `pi/watch-batch.ts`.

## Ordering logic

Spike first, because S3 and S4 can change the design. Then refactor pi behind the adapter with no behaviour change, so the existing 423 tests become the regression gate. Then add agy pieces in dependency order.

C1 (config) and C2 (pi refactor) touch disjoint files and can run in parallel. C3 joins them.

## Capabilities

| ID | Deliverable | Files | Size | Depends on |
|---|---|---|---|---|
| S0 | Spike S1-S5 → `spike.md` | `docs/issues/agy-harness/spike.md` | S (research) | spec approval |
| C1 | Config: `harness`, `effort`; warnings for wrong-harness keys; unknown harness dropped | `src/config/config.ts`, `src/config/profiles.ts`, `test/config/*` | M | — |
| C2 | pi behind `ChildHarness`: argv, bin, session path, `readTurn`, `readRefusal` moved, no behaviour change | `src/children/harness/{types,pi,index}.ts`, `src/children/launch-script.ts` | M | — |
| C3 | Spawn resolves `profile.harness` → adapter; refuses agy spawns whose role declares `tools` (Q1) | `src/children/spawn.ts`, `test/children/spawn.test.ts` | S | C1, C2 |
| C4 | agy adapter: argv (`--model`, `--effort`, `-i` + task file, no `-p`), bin (`TINYSUBAGENT_AGY_BIN`, default `agy`), `supportsExtension: false` | `src/children/harness/agy.ts`, `test/children/harness-agy.test.ts` | S | C2, S0 (S1 flags) |
| C5 | Task markdown per harness: agy writes sidecar via temp + rename | `src/children/task-markdown.ts`, its test | S | C2 |
| C6 | Original Stop-hook logic (superseded by approved project-cwd amendment; no longer in runtime) | Removed | M | S0 (S2, S3), C4 |
| C7 | Per-run hook wiring and cleanup; global-config byte-identity guard | `src/children/launch-script.ts`, `src/paths.ts`, `src/children/harness/agy.ts`, test | M | S0 (S4), C4, C6 |
| C8 | Outcome table: missing binary → failed before pane opens; non-zero exit → pane open; exit 0 without report → wrapper writes `no-output` report sidecar before exit sidecar (Q4) | `src/children/launch-script.ts`, `src/children/harness/agy.ts`, test | S | C3, C4 |
| C9 | Docs: README profile keys; spec status; AGENTS.md spec-memory entry | `README.md`, `AGENTS.md`, `docs/issues/agy-harness/spec.md` | S | C1-C8 |
| C10 | Manual end-to-end: real agy child in herdr pane reports; global config diff empty | `scripts/smoke-agy.ts` (new, if a script is needed) | S | C1-C8 |

## Checkpoints

| Checkpoint | After | Expected |
|---|---|---|
| CP0 | now | `70f4c9e`; typecheck clean; 423 pass / 0 fail |
| CP-S0 | S0 | `spike.md` recorded. S4 failed → stop and return to the user. |
| CP1 | C1, C2, C3 | Typecheck clean. The original 423 tests pass **unedited**. New config and spawn cases pass. Default profiles launch the same argv as today. |
| CP2 | C4, C5 | Typecheck clean. Suite green. agy argv has no `-p`. |
| CP3 | C6, C7, C8 | Typecheck clean. Suite green. Nudge logic covered by a stub. Global config guard passes. |
| CP4 | C9, C10 | `npm run typecheck` and `npm test` pass. Manual E2E run and output reviewed by the human. Spec success criteria 1-8 checked off. |

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| S4: child cannot load a hook scoped to its own run | High (blocks C7) | Stop, return to user. Do not fall back to global hooks without approval. |
| S3: Stop hook cannot force another turn | High (changes report channel) | Historical risk; the approved amendment removes Stop-hook reporting and uses report sidecars. |
| agy flags or hook payload differ across agy versions | Medium | Pin the agy version tested in `spike.md`. Adapter tests use a recorded fixture. |
| Interactive tool approval holds unattended batches | Medium | Documented default (Q2). `--dangerously-skip-permissions` only as explicit opt-in. |
| Role `tools` allowlist silently widens agy permissions | High | C3 refuses agy spawns whose role declares `tools` (Q1). Tested in spawn tests. |
| Pi regression during refactor | High | C2 is a pure move. Existing suites must pass unedited. |
| Stub hook test passes but real agy differs | Medium | C10 manual E2E is a hard gate for CP4. |
| Test model `gpt-oss-120b` removed 2026-11-02, or not on the test account's plan | High | S1 pins the `--model` string and confirms access first. If the model is missing, stop and re-pin before S0 completes. Keep it out of unit tests so a model change touches only S0 and C10. |
| `--effort` not accepted by `gpt-oss-120b` | Medium | S1 checks it. If rejected, the agy `effort` key is documented as unsupported for that model and C4 omits the flag. |

## Decisions (resolved)

- Q1: reject role `tools` allowlists on agy (C3).
- Q2: approval prompts hold for a human; no skip flag in v1.
- Q3: original nudge count was 1; superseded by the approved amendment removing the nudge.
- Q4: exit 0 with no report → `failed / no-output` via wrapper-written sidecar (C8).

## Open questions

None blocking. S0 may add new ones; they go here before any code.
