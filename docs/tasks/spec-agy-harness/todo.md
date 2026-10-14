# Todo: a profile can choose the child CLI (pi or agy)

Implements `docs/specs/spec-agy-harness.md` per `docs/tasks/spec-agy-harness/plan.md`.
Baseline at `70f4c9e`: typecheck clean, `npm test` → 423 pass / 0 fail.

**Spec approved; Q1-Q4 decided (2026-10-14). Do not start C1 or later until S0 is recorded in `spike.md`.**

Every task: `npm run typecheck` and `npm test` pass before it is ticked. Pi suites are never edited to make a task pass.

- [x] **S0 — spike (research, no `src/` change).** Record results in `docs/tasks/spec-agy-harness/spike.md`.
  - S1: `agy -i "<prompt>"` stays at the prompt after the first turn. Pin the agy version. Test model is `gpt-oss-120b` (Google lists removal 2026-11-02, not on Enterprise): record the exact `--model` string from `agy`, confirm the account can run it, and confirm `--effort` is accepted with it.
  - S2: Stop hook stdin gives `conversationId` and `transcriptPath`.
  - S3: Stop hook `decision: "continue"` with `reason` re-enters the loop (live test).
  - S4: per-run hook scope without touching `~/.gemini` or `~/.agents`. **Blocking.**
  - S5: `transcriptPath` is parseable for last assistant text. Not blocking; if no, `readTurn` returns null.
  - Done when: each of S1-S5 has pass/fail and evidence. S4 fail → stop and tell the user.

- [x] **C1 — config.** `harness` (`pi` | `agy`) and `effort` (agy) on `Profile`.
  - Acceptance: missing `harness` → `pi`; unknown value → profile dropped with one warning; `thinking` on agy and `effort` on pi → ignored with warning. (The Q1 allowlist rule is in C3, not here: it reads the role's `tools`, not the profile.)
  - Verify: new cases in `test/config/*`; existing config tests unedited.
  - Files: `src/config/config.ts`, `src/config/profiles.ts`, `test/config/*`.

- [x] **C2 — pi behind `ChildHarness` (pure refactor).**
  - Acceptance: `src/children/harness/{types,pi,index}.ts` hold argv, bin, session path, `readTurn`, `readRefusal` for pi. `launch-script.ts` calls the adapter. Default output unchanged.
  - Verify: all 423 existing tests pass **unedited**.
  - Files: `src/children/harness/{types,pi,index}.ts`, `src/children/launch-script.ts`.

- [x] **C3 — spawn wiring.** Depends on C1, C2.
  - Acceptance: `spawn.ts` resolves `profile.harness` to an adapter and passes it to `launch-script.ts`. A pi profile launches the same argv as before. An agy profile whose role declares a non-empty `tools` list is refused before the pane opens, with the spec's error text (Q1). A role with no `tools` spawns normally on agy.
  - Verify: spawn tests for pi and agy profiles; agy + `tools` refused; agy + no `tools` allowed; unchanged pi argv assertions pass.
  - Files: `src/children/spawn.ts`, `test/children/spawn.test.ts`.

- [x] **C4 — agy adapter argv and bin.** Depends on C2, S0.
  - Acceptance: argv has `--model`, `--effort`, `-i` + task file path, and no `-p`. Prompt is never inline. Bin = `TINYSUBAGENT_AGY_BIN` or `agy`. `supportsExtension: false`.
  - Verify: `test/children/harness-agy.test.ts` asserts each flag and the absence of `-p`.
  - Files: `src/children/harness/agy.ts`, `test/children/harness-agy.test.ts`.

- [x] **C5 — agy task instruction.** Depends on C2.
  - Acceptance: agy task markdown tells the child to write `{"type":"done","result":...}` or `{"type":"failed",...}` to `$PI_TINYSUBAGENT_REPORT` via temp file + rename. pi task text unchanged.
  - Verify: task-markdown test per harness.
  - Files: `src/children/task-markdown.ts`, its test.

- [x] **C6 — Stop hook logic.** Depends on S0 (S2, S3), C4.
  - Acceptance: valid sidecar → allow. Missing + first stop → `decision: "continue"` with the report reason. Missing + second stop → allow, write nothing. Counter is per conversation id. Sidecar JSON is validated before any allow. Hook never blocks indefinitely.
  - Verify: `test/children/agy-stop-hook.test.ts` with scripted stdin payloads, covering each branch.
  - Files: `src/children/agy-stop-hook.ts`, `test/children/agy-stop-hook.test.ts`.

- [x] **C7 — per-run hook wiring and global-config guard.** Depends on S0 (S4), C4, C6.
  - Acceptance: hook is installed in the isolated child run cwd and removed after it. A fresh run cwd is temporarily added to `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`, then removed only if this run added it. `~/.gemini/config/hooks.json` and `~/.agents/` remain byte-identical.
  - Verify: test with a temp HOME; `.gemini/config/hooks.json` and `.agents/` remain byte-identical, temporary trust entry is removed, and the run workspace is deleted.
  - Files: `src/children/launch-script.ts`, `src/paths.ts`, `src/children/harness/agy.ts`, test.

- [x] **C8 — agy outcome table.** Depends on C3, C4.
  - Acceptance: missing binary → `failed` before the pane opens with a failure sidecar. Non-zero exit → `failed / exit`, pane open. Exit 0 with no report → the agy wrapper writes `{"type":"failed","reason":"no-output"}` to the report sidecar before the exit sidecar, only if none exists (Q4); the watcher is unchanged. Exit 0 with a report → `completed / report`. Unreported stop after the nudge → nothing written, pane open.
  - Verify: missing-binary spawn test asserts no pane open and a failure sidecar; existing watcher tests cover non-zero exit, completed report and unreported stops; wrapper tests verify atomic no-output sidecar ordering and report preservation.
  - Files: `src/children/spawn.ts`, `src/children/harness/agy.ts`, test.

- [x] **C9 — docs and memory.** Depends on C1-C8.
  - Acceptance: README documents `harness`, `effort`, `TINYSUBAGENT_AGY_BIN`, and the rejected keys. Spec status updated. `AGENTS.md` spec-memory has an entry for `spec-agy-harness.md`.
  - Verify: `npm run typecheck` and `npm test`; diff review.
  - Files: `README.md`, `AGENTS.md`, `docs/specs/spec-agy-harness.md`.

- [x] **C10 — manual end-to-end (CP4 gate).** Depends on C1-C8.
  - Model: `gpt-oss-120b` (test blocker; plan "Test model"). Must pass before 2026-11-02.
  - Acceptance: a real agy child in a herdr pane writes the requested report → watcher outcome `completed / report`, pane closes. Global agy config diff is empty.
  - Verify: live agy 1.3.5, herdr 0.9.3 run using `gpt-oss-120b-medium` + matching `medium` effort reported exactly `AGY_E2E_REPORT_OK`; watcher outcome was `completed / report`; completed pane was closed; run artifacts and temporary trusted-workspace entry were cleaned.
  - Files: `scripts/smoke-agy.ts` (new, if needed).

## Checkpoints

- [x] **CP0** — `70f4c9e`, typecheck clean, 423 pass / 0 fail. *(verified this run)*
- [x] **CP-S0** — original S0 spike recorded. S4 passed for isolated cwd; the project-cwd amendment's A1 investigation is blocked (see below).
- [x] **CP1** — after C1-C3: typecheck clean; original 423 tests pass unedited; default profiles unchanged.
- [x] **CP2** — after C4-C5: typecheck clean; suite green; no `-p` in agy argv.
- [x] **CP3** — after C6-C8: typecheck clean; suite green; nudge stub test; global-config guard passes.
- [x] **CP4** — after C9-C10: `npm run typecheck` and `npm test` pass; manual E2E reviewed; spec success criteria 1-8 checked.

### C10 live-run note (2026-10-14)

An initial live attempt exposed ambiguous task wording (the model inspected the task markdown instead of reporting the requested result). The instruction was tightened. The passing run returned exactly `AGY_E2E_REPORT_OK`, and the watcher classified it as `completed / report`; the test runner closed the pane. Temporary artifacts and the run's trust entry in `~/.gemini/antigravity-cli/settings.json` were removed after verifying cleanup.

## Project-directory amendment (approved; blocked at A1)

The approved spec amendment changes agy's working directory from an isolated per-run workspace to the resolved project directory. Existing project `.agents/hooks.json` content and behavior must be preserved; global agy config remains untouched. Complete these tasks without changing the pi path.

- [x] **A1 — hook-preservation spike: BLOCKED.** agy 1.3.5 supports one project `.agents/hooks.json` and documents no per-run overlay/include mechanism. Editing/restoring shared project state cannot guarantee preservation across concurrent/external writes or uncatchable termination; malformed existing JSON cannot be safely merged. The original isolated cwd avoids this conflict but fails the amendment's project-cwd requirement. See `spike.md` and S4 in the spec. **A2/A3 must not proceed without a supported overlay or revised requirement.**
  - Acceptance: determine whether a safe implementation strategy exists; report an unsafe/blocked result before implementation.
  - Verify: inspected the installed agy 1.3.5 hook contract; no live project-file mutation was attempted because that cannot establish crash/concurrency guarantees.
  - Files: `docs/tasks/spec-agy-harness/spike.md`, `docs/specs/spec-agy-harness.md`.
  - Dependency: none.

- [blocked] **A2 — implement project cwd and safe per-run hook lifecycle.** Blocked: A1 found no safe hook-preservation strategy. Do not change runtime behavior until agy supports an overlay or the requirement is revised.
  - Acceptance: agy receives the resolved project cwd; existing project hooks are preserved and run; project hook file is restored byte-for-byte after normal exit and failure; global agy config is unchanged; agy trust cleanup remains correct.
  - Verify: focused unit tests cover absent/existing hooks, cleanup on exit/failure, and concurrent or conflicting runs as dictated by A1; run `npm run typecheck` and `npm test`; repeat the live disposable-project check.
  - Files likely touched: `src/children/launch-script.ts`, `src/children/launch-paths.ts`, `src/children/spawn.ts`, and launch/spawn tests.
  - Dependency: A1.

- [blocked] **A3 — update end-to-end evidence and docs.** Blocked on A2. Existing C10 evidence applies only to the prior isolated-workspace implementation; project-cwd amendment is not verified.
  - Acceptance: report outcome remains correct; project cwd is confirmed; pre-existing hook file is byte-identical afterward and its hook behavior is preserved; global config remains unchanged.
  - Verify: manual real-agy/herdr E2E; `npm run typecheck` and `npm test`.
  - Files: `docs/tasks/spec-agy-harness/spike.md`, `docs/tasks/spec-agy-harness/todo.md`, `docs/specs/spec-agy-harness.md`, possibly `README.md`.
  - Dependency: A2.

## Decisions (resolved 2026-10-14)

- [x] Q1 — reject role `tools` allowlists on agy (C3).
- [x] Q2 — approval prompts hold for a human; no skip flag in v1.
- [x] Q3 — nudge count 1 (C6).
- [x] Q4 — exit 0 with no report → `failed / no-output` via wrapper-written sidecar (C8).
