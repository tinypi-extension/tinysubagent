# Todo: code layout refactor

Implements `docs/spec-code-layout.md` per `tasks/plan.md`. Baseline at `87dd773`: typecheck
clean, `npm test` → **241 pass / 0 fail**.

**Rules for every task below**
- Rewrite import paths **mechanically** from the verified file:line lists in the recon reports.
  Never infer a path from a filename.
- Keep relative imports extension-ful (`.ts`) and type-only imports `import type`.
- After each task group, run its checkpoint. A checkpoint is passed on the **right numbers**,
  not a zero exit code.
- Never let `npm test` match zero files. Never delete, skip or weaken a test.

Legend: `⚠` = silent-failure risk (suite stays green, runtime breaks).

---

## M1 — `paths-hardening`

- [x] **T1.1 Create `src/paths.ts`**
  - Acceptance: exports `findPackageRoot(start: string): string`, `packageRoot`, `srcDir`,
    `pluginDir()`, `childExtensionPath`. `findPackageRoot` walks up to the nearest directory
    containing `package.json` and **terminates** at the filesystem root by returning the start
    directory rather than throwing. It is the only file in the repo that reads `import.meta.url`.
  - Verify: `npx tsc --noEmit`; `node -e` probe printing all five values against the repo root.
  - Files: `src/paths.ts` (new)

- [x] **T1.2 Rewire `pluginDir()` in `src/herdr.ts`**
  - Acceptance: `src/herdr.ts:35-37` no longer computes a path; `pluginDir` is re-exported from
    `./paths.ts` and still exported under the same name, so no caller changes. Now-unused
    `fileURLToPath` / `dirname` imports are removed (keep `join` only if still used).
  - Verify: `npx tsc --noEmit`; `npm test` → 241 pass; `node -e` shows `pluginDir()` contains
    `herdr-plugin.toml` and `dispatch.sh`.
  - Files: `src/herdr.ts`

- [x] **T1.3 Rewire `childExtensionPath` in `src/spawn.ts`** ⚠
  - Acceptance: the local `packageRoot` const and the `join(packageRoot, "src", "child.ts")`
    literal are deleted; `childExtensionPath` is re-exported from `./paths.ts` and resolves to
    the existing `src/child.ts`. This is the highest-risk silent breakage in the refactor —
    it has zero existing test coverage.
  - Verify: `npx tsc --noEmit`; `npm test` → 241 pass; `npm run smoke:tool` and
    `npm run smoke:interrupt` both spawn a real child that reports and settles.
  - Files: `src/spawn.ts`

- [x] **T1.4 Add `test/paths.test.ts`**
  - Acceptance: proves `pluginDir()` resolves to the shipped plugin with both files present;
    proves `childExtensionPath` points at a file that exists on disk; proves `findPackageRoot`
    finds the repo root when started from a nested directory and terminates with no
    `package.json` above it (use a temp dir tree). Closes the uncovered regression from T1.3.
  - Verify: `node --test test/paths.test.ts` → all pass; `npm test` → 241+N pass, 0 fail.
  - Files: `test/paths.test.ts` (new)

- [x] **T1.5 Checkpoint CP1** ✅ passed independently at `17e2fa1`: typecheck clean, `npm test` → 246 pass / 0 fail, 15 test files, `smoke:tool` + `smoke:interrupt` exit 0
  - Acceptance: clean typecheck; `npm test` → **241+N pass / 0 fail**; both real-child smokes
    pass. Commit `M1: add src/paths.ts package-root resolver`.
  - Verify: `npm run typecheck && npm test && npm run smoke:tool && npm run smoke:interrupt`

---

## M2 — `deep-splits`

### Launch (1 importer, fully covered by `test/launch.test.ts`)

- [x] **T2.1 Create `src/launch-paths.ts`**
  - Acceptance: holds `runId`, `safeName`, `timestampForArtifacts`, `timestampForSession`,
    `childSessionDirFor`, `LaunchPaths`, `LaunchPathsInput`, `buildLaunchPaths`, `LaunchFile`,
    `writeLaunchFiles`. `buildLaunchPaths` remains the **only** place a sidecar path is computed.
  - Verify: `npx tsc --noEmit`
  - Files: `src/launch-paths.ts` (new)

- [x] **T2.2 Create `src/launch-script.ts`**
  - Acceptance: holds `shellEscape`, `LaunchScriptOptions`, `DEFAULT_HOLD_OPEN_SECS`,
    `buildLaunchScript`, `PiArgvOptions`, `buildPiArgv`, `resolvePiBin`, `resolveLaunchPrefix`.
    `buildLaunchScript` must **not** compute any path — it keeps receiving `taskFile`,
    `reportFile`, `exitCodeFile`, `childSessionFile` as option strings.
  - Verify: `npx tsc --noEmit`; `test/launch.test.ts` assertions on `.done`/`.exitcode` suffixes
    still pass.
  - Files: `src/launch-script.ts` (new)

- [x] **T2.3 Create `src/task-markdown.ts`**
  - Acceptance: holds `buildTaskMarkdown`; imports `REPORT_TOOL_NAME` from `./types.ts`. No other
    intra-module dependency.
  - Verify: `npx tsc --noEmit`
  - Files: `src/task-markdown.ts` (new)

- [x] **T2.4 Reduce `src/launch.ts` to a façade**
  - Acceptance: `src/launch.ts` is ~10 lines re-exporting the three modules above, so
    `spawn.ts` and `test/launch.test.ts` keep importing from `./launch.ts` unchanged. No
    symbol is renamed; no logic remains in the file.
  - Verify: `npm run typecheck && npm test` → **241+N pass / 0 fail**
  - Files: `src/launch.ts`

- [x] **T2.5 Checkpoint CP2a** — typecheck + `npm test` at 241+N / 0 fail. ✅ passed independently at `fe051eb`: typecheck clean, 246/0, `launch.test.ts` 15/0, all 19 exports survive, `spawn.ts` + `launch.test.ts` byte-identical, new files 119/147/28 ≤200, `launch.ts` 15 lines, `smoke:tool` exit 0

### Child (4 test-visible symbols; every extracted function is directly tested)

- [x] **T2.6 Create `src/report.ts`**
  - Acceptance: holds `ChildSettle` and the exported `writeReportFile` / `writeResultReport`,
    with `reportFilePath` and `writeAtomic` private. Both writers route through the single
    `writeAtomic`. Byte-level sidecar contract preserved: `{done}`, `{done,result}`,
    `{failed,reason[,message]}`.
  - Verify: `npx tsc --noEmit`
  - Files: `src/report.ts` (new)

- [x] **T2.7 Create `src/settle.ts`**
  - **As-built:** `failureDetail` is **exported**, not private — the `agent_settled` failure
    branch in `child.ts` calls `writeReportFile("failed", failureDetail(lastMessages))`, so
    keeping it private would have silently dropped the `"no-output"` reason. Spec table updated.
  - Acceptance: holds `SettleVerdict`, `settleReason` (exported), `TurnMessage` (exported) and
    private `failureDetail`; imports `ChildSettle` as a **type** from `./report.ts`.
  - Verify: `npx tsc --noEmit`
  - Files: `src/settle.ts` (new)

- [x] **T2.8 Create `src/preflight.ts`**
  - Acceptance: holds `preflightFailure`, `PreflightRegistry`, `PreflightContext`,
    `preflightRefusal`, and **`errorText` exported** (the default entrypoint's input-catch hook
    still needs it). No intra-repo imports.
  - Verify: `npx tsc --noEmit`
  - Files: `src/preflight.ts` (new)

- [x] **T2.9 Trim `src/child.ts` to the entrypoint** ⚠
  - **As-built:** `child.ts` is **207 lines**, above the 200 budget — 81 of them the mandated
    rationale header. No further split seam exists (all three hooks share the closure-local
    `finished`/`lastMessages`/`runSignal`). Documented as a fourth exception in spec criterion 5.
  - Acceptance: `child.ts` keeps only `default tinysubagentChild` plus its rationale header;
    `finished`, `lastMessages` and `runSignal` stay **closure-local** and are not hoisted to
    module scope. Both writers still route through the single `writeAtomic`. The default export
    keeps its identity because it is the `-e` entrypoint.
  - Verify: `npm run typecheck`; `test/child.test.ts` overwrite-after-report test passes;
    `npm run smoke:tool` still spawns a real child.
  - Files: `src/child.ts`

- [x] **T2.10 Update `test/child.test.ts` imports**
  - Acceptance: four import lines re-pointed — `tinysubagentChild` unchanged path,
    `preflightFailure` → `./preflight.ts`, `settleReason` → `./settle.ts`,
    `writeReportFile`/`writeResultReport` → `./report.ts`. **All 29 cases still present**; no
    assertion edited.
  - Verify: `node --test test/child.test.ts` → 29 pass
  - Files: `test/child.test.ts`

- [x] **T2.11 Checkpoint CP2b** — typecheck + `npm test` at 241+N / 0 fail. ✅ passed independently at `e057abf`: typecheck clean, 246/0, `child.test.ts` 29/0 (29 before, 29 after), glob 15, new files 86/68/109 ≤200, both report writers route through the single `writeAtomic`, `smoke:tool` exit 0

### Spawn (6 importers — highest fan-out of the three)

- [x] **T2.12 Create `src/contract.ts`**
  - Acceptance: holds `TaskInput`, `ToolParams`, `SpawnRequest`, `SpawnContext`, `Spawned`,
    `SpawnFailed`, `errorMessage`. `errorMessage` stays a separate copy from `child.ts`'s
    `errorText` — do **not** unify them.
  - Verify: `npx tsc --noEmit`
  - Files: `src/contract.ts` (new)

- [x] **T2.13 Create `src/requests.ts`**
  - Acceptance: holds `MAX_PARALLEL_TASKS`, `uniqueName`, `collectRequests`,
    `resolveProjectAgentDir`, `resolveCwd`. `MAX_PARALLEL_TASKS` must land here (it is used
    in-file only by `collectRequests`) so that no `requests → spawn` back-edge is created.
  - Verify: `npx tsc --noEmit`
  - Files: `src/requests.ts` (new)

- [x] **T2.14 Trim `src/spawn.ts`**
  - Acceptance: holds `TOOL_NAME`, `childExtensionPath` (re-exported from `./paths.ts`),
    `spawnOne`, `parentModelSpec`, `parentThinking`. `parentModelSpec`/`parentThinking` stay
    here, not in `requests.ts`, to keep the pi `ExtensionContext` type out of the path module.
    Imports from `./contract.ts`. **File ≤ 200 lines.**
  - Verify: `npx tsc --noEmit`; `wc -l src/spawn.ts` ≤ 200
  - Files: `src/spawn.ts`

- [x] **T2.15 Update every `spawn.ts` importer**
  - Acceptance: `index.ts` imports `MAX_PARALLEL_TASKS`/`collectRequests`/`resolveCwd`/
    `resolveProjectAgentDir` from `./src/requests.ts` and `ToolParams`/`SpawnContext` from
    `./src/contract.ts`; `test/spawn.test.ts`, `test/extension.test.ts` and
    `scripts/smoke-layout.ts` re-pointed for `MAX_PARALLEL_TASKS`, `ToolParams`, `SpawnContext`
    and `errorMessage`. `TOOL_NAME`/`spawnOne`/`parentModelSpec`/`parentThinking` keep resolving
    from `./src/spawn.ts`. All 23 spawn cases and 18 extension cases still present.
  - Verify: `npm run typecheck && npm test` → 241+N / 0 fail
  - Files: `index.ts`, `test/spawn.test.ts`, `test/extension.test.ts`, `scripts/smoke-layout.ts`

- [x] **T2.16 Checkpoint CP2c** — typecheck + `npm test` at 241+N / 0 fail + `spawn.ts` ≤ 200. ✅ passed independently at `813a4b2`: typecheck clean, 246/0, spawn 23/0, extension 18/0, glob 15, `spawn.ts` **exactly 200**, `contract.ts` 77, `requests.ts` 97, no `src/ → spawn.ts` back-edge, `errorText`/`errorMessage` still separate, `smoke:tool` exit 0. Note: `spawn.ts` has **zero** line headroom — M3 must re-check after its import paths lengthen.

---

## M3 — `src-reorg` (one commit; must not be partially applied)

- [x] **T3.1 Move `src/` files into subfolders (use `git mv`)**
  - Acceptance: `config/{config,agents,profiles}.ts`; `herdr/{cli,layout}.ts`
    (`herdr.ts`→`cli.ts`); `children/{spawn,launch,launch-paths,launch-script,task-markdown,watcher,session,child,report,settle,preflight,contract,requests}.ts`;
    `present/{ack,steer}.ts`; unchanged at `src/` root: `paths.ts`, `types.ts`,
    `tool-patterns.ts`. **Also update `src/paths.ts`: `childExtensionPath` tail becomes
    `join(srcDir, "children", "child.ts")`** — M1 deliberately shipped `join(srcDir, "child.ts")`
    because `src/children/child.ts` did not exist yet. That tail and the `git mv` of `child.ts`
    must be the same commit, or the `-e` hook points at a file that is not there while the whole
    suite stays green.
  - Verify: `git status` shows renames, not delete+add; `test/paths.test.ts`'s on-disk
    existence assertion still passes
  - Files: all of `src/`

- [x] **T3.2 Rewrite intra-`src/` imports**
  - Acceptance: every cross-module relative import in `src/` re-pointed, including
    `src/ack.ts`→`../config/profiles.ts`, `src/layout.ts`→`./cli.ts` (from `src/herdr/`),
    `src/steer.ts`→`../config/profiles.ts` + `../children/watcher.ts`,
    `src/watcher.ts`→`../herdr/cli.ts` + `../config/profiles.ts`, and the `../types.ts`
    depth changes in `agents/child/config/launch/profiles`.
  - Verify: `npx tsc --noEmit` clean with **zero** unresolved modules
  - Files: `src/**/*.ts`

- [x] **T3.3 Rewrite `index.ts` src imports**
  - Acceptance: all ten import lines re-pointed per the verified list; `./src/types.ts` and
    `pi.extensions: ["./index.ts"]` unchanged; `index.ts` stays at the repo root.
  - Verify: `npx tsc --noEmit`
  - Files: `index.ts`

- [x] **T3.4 Move `test/` files into mirrored subfolders (use `git mv`)**
  - Acceptance: `test/config/{config,agents,profiles}.test.ts`; `test/herdr/{cli,layout}.test.ts`
    (`herdr.test.ts`→`cli.test.ts`); `test/children/{child,spawn,watcher,launch,session}.test.ts`;
    `test/present/{ack,steer}.test.ts`; `test/paths.test.ts`; unchanged at root:
    `test/tool-patterns.test.ts`. `test/extension.test.ts` **stays at the test root in M3** —
    it moves to `test/pi/` in M4, once `src/pi/` actually exists, so the mirror is never
    dishonest. Per-folder counts at M3: config 63, children 98, herdr 38, present 14, root 28
    (extension 18 + tool-patterns 10), paths N — summing to **241 + N** as a check that no
    relocation dropped a case.
  - Verify: `node -e 'console.log(require("node:fs").globSync("test/**/*.test.ts").length)'` → 15
  - Files: all of `test/`

- [x] **T3.5 Rewrite test imports**
  - Acceptance: every `../src/<name>.ts` re-pointed to `../../src/<area>/<name>.ts`; every
    `../index.ts` → `../../index.ts`; `test/tool-patterns.test.ts` unchanged. **No assertion and
    no case count changes** — only import lines.
  - Verify: `npm test` → **241+N pass / 0 fail**
  - Files: `test/**/*.test.ts`

- [x] **T3.6 Rewrite `scripts/*.ts` smoke imports**
  - Acceptance: all five smoke scripts re-pointed; their own locations and
    `package.json` `smoke*` entries unchanged; `../index.ts` stays `../index.ts`.
  - Verify: `npm run smoke:layout`; `npm run smoke:provider-error`
  - Files: `scripts/smoke.ts`, `scripts/smoke-tool.ts`, `scripts/smoke-layout.ts`,
    `scripts/smoke-interrupt.ts`, `scripts/smoke-provider-error.ts`

- [x] **T3.7 Flip the test glob in `package.json`** ⚠
  - Acceptance: `"test": "node --test \"test/**/*.test.ts\""` — **quoted**, because npm runs
    scripts through `/bin/sh`, where an unquoted `**` degrades to `*` and then matches only
    `test/*/*.test.ts`, silently dropping root-level `test/tool-patterns.test.ts`.
    `tsconfig.json` needs no change (`src/**/*.ts` / `test/**/*.ts` are already recursive).
  - Verify: `npm test` → 241+N / 0 fail; `globSync(...).length === 15`; explicitly confirm
    `test/tool-patterns.test.ts`'s 10 cases ran
  - Files: `package.json`

- [x] **T3.8 Fix stale path references in code comments**
  - Acceptance: `herdr-plugin/herdr-plugin.toml:5` names `src/herdr/cli.ts` and
    `test/herdr/cli.test.ts`; `src/children/watcher.ts` comment names `src/children/child.ts`;
    `src/types.ts` comment names `src/children/spawn.ts`. Comments only — no logic.
  - Verify: `rg -n "src/herdr\.ts|src/spawn\.ts|src/child\.ts" src/ herdr-plugin/` returns nothing
  - Files: `herdr-plugin/herdr-plugin.toml`, `src/children/watcher.ts`, `src/types.ts`

- [x] **T3.9 Checkpoint CP3** ✅ passed independently at `b9a295e`: typecheck clean; `npm test` → 246 pass / 0 fail; `globSync` → 15; per-folder 63/98/38/14/33 = 246; `tool-patterns` 10; `herdr/cli` 19; 32 `R` entries and zero delete+add; `spawn.ts` 200; `childExtensionPath` → `src/children/child.ts` exists; all five smokes exit 0
  - Acceptance: clean typecheck; `npm test` → **241+N / 0 fail**; `globSync(...).length === 15`;
    both real-child smokes pass. Commit `M3: reorganize src/ and test/ into role subfolders`.
  - Verify: `npm run typecheck && npm test && npm run smoke:tool && npm run smoke:interrupt`
  - **Watch for the 222-passing file-level-failure signature** — it means
    `test/herdr/cli.test.ts` threw at import and 19 cases vanished.

---

## M4 — `index-decompose`

- [x] **T4.1 Create `src/present/describe.ts`** ✅ `deab471`: 114 lines, exports all six symbols, bodies verbatim (0 dropped string literals, 140 moved lines verified)
  - Acceptance: holds `MAX_LISTED_AGENTS`, `MAX_ADVERTISED_DESCRIPTION`, `advertiseAgents`,
    `buildToolDescription`, `PROMPT_GUIDELINES`, `buildParameters`. Pure functions, no I/O.
  - Verify: `npx tsc --noEmit`
  - Files: `src/present/describe.ts` (new), `index.ts`

- [x] **T4.2 Create `src/present/ack-render.ts`** ✅ `deab471`: 63 lines, exports all six symbols, no `src/pi/` import (verified); `index.ts` 550→390
  - Acceptance: holds `SpawnedEntry`, `AckDetails`, `NOTE_STARTED`, `NOTE_NOTHING`,
    `THINKING_COLORS`, `renderAck`. Must **not** import from `src/pi/` (avoids the plausible
    `ack-render ↔ tool` cycle).
  - Verify: `npx tsc --noEmit`
  - Files: `src/present/ack-render.ts` (new), `index.ts`

- [x] **T4.3 Create `src/pi/capability.ts` as a factory** ✅ `10c77a7`: 98 lines; no module-level mutable state in `src/pi` (verified); `reset()` only on the successful link/enable branch
  - Acceptance: `createCapabilityCheck(): { ensureReady(); probe(options?); reset() }` replaces
    the module-level `let capabilityCheck` (`index.ts:57`). No module-level mutable state
    remains. Failed probes are still not cached (self-healing); `reset()` is what the plugin
    repair flow needs after a successful link/enable.
  - Verify: `npx tsc --noEmit`
  - Files: `src/pi/capability.ts` (new), `index.ts`

- [x] **T4.4 Create `src/pi/plugin-fix.ts`** ✅ `10c77a7`: 69 lines; `fixOffered` flipped before `ctx.ui.confirm` exactly as before
  - Acceptance: holds `offerPluginFix` (the `ctx.ui.confirm` link/enable repair flow). Receives
    the capability `reset` and the per-session `fixOffered` guard as dependencies rather than
    reaching for module state.
  - Verify: `npx tsc --noEmit`
  - Files: `src/pi/plugin-fix.ts` (new), `index.ts`

- [x] **T4.5 Create `src/pi/watch-batch.ts`** ✅ `10c77a7`: 81 lines; `watchers`/`shuttingDown`/`columns` still owned by `index.ts` and injected
  - Acceptance: holds `deliver` and `watchBatch`. Tracked so that it is `index.ts`'s
    `waitForSubagent` call that disappears, not the behavior. Watchers set and `shuttingDown`
    stay owned by the entrypoint and are passed in.
  - Verify: `npx tsc --noEmit`
  - Files: `src/pi/watch-batch.ts` (new), `index.ts`

- [x] **T4.6 Create `src/pi/lifecycle.ts`** ✅ `10c77a7`: 40 lines; both subscriptions preserved, `registerLifecycle` still called before `pi.registerTool` (not named `session.ts` — that name is taken by the
  JSONL reader in `src/children/session.ts`)
  - Acceptance: `registerLifecycle(pi, deps)` owns the `session_start` and `session_shutdown`
    subscriptions, including aborting and clearing watchers on shutdown.
  - Verify: `npx tsc --noEmit`
  - Files: `src/pi/lifecycle.ts` (new), `index.ts`

- [x] **T4.7 Create `src/pi/tool.ts`** ✅ `7d2a88a`: **exactly 200 lines** (one doc-comment line trimmed to fit); exports `ToolDeps` + `createTool(deps)`; holds `failure` and the whole former `registerTool` object with `execute`/`renderResult` verbatim; does not call `pi.registerTool`. `ToolDeps` carries `pi` beyond the briefed list (needed by `pi.getAllTools()` and `watchBatch`).
  - Acceptance: `failure` and `createTool(deps)` live here — the whole former
    `registerTool` object including `execute` and `renderResult`. Registration itself stays in
    `index.ts`.
  - Verify: `npx tsc --noEmit`
  - Files: `src/pi/tool.ts` (new), `index.ts`

- [x] **T4.8 Reduce `index.ts` to wiring** ⚠ ✅ `7d2a88a`: **217 → 82 lines** (≤ 120). Verified by read-back: no `Type.`/`renderResult`/`execute`/`promptSnippet`/`promptGuidelines`/`Text(`/`Box(` present. `registerLifecycle` at line 61 still precedes `pi.registerTool` at line 70. Dead `herdrPaneOpen` import deleted; `rg -n "import\.meta\.url" src/ index.ts` → `src/paths.ts:40` only. Doc comment extended with 2 lines naming the new homes (deliberate, documented).
  - Acceptance: `index.ts` contains only the `isInsideHerdr()` guard, registration-time
    `loadConfig`/`discoverAgents`/`buildParameters` reads, per-session state (`watchers`,
    `shuttingDown`, `fixOffered`, `columns`), `pi.registerTool(createTool(deps))` and
    `registerLifecycle(pi, deps)`. The dead `herdrPaneOpen` import is deleted. **≤ 120 lines.**
    No tool schema, no TUI rendering, no herdr probe, no `waitForSubagent` call.
  - Verify: `npx tsc --noEmit`; `wc -l index.ts` ≤ 120;
    `rg -n "import\.meta\.url" src/ index.ts` → only `src/paths.ts`
  - Files: `index.ts`

- [x] **T4.9 Verify the dependency graph is still acyclic** ✅ re-derived independently by the orchestrator (not the worker's script): 31 nodes (30 `src/**/*.ts` + `index.ts`), 73 edges, **0 cycles**, 0 relative imports escaping the graph → VERDICT acyclic. `find src -name index.ts` → nothing (no barrels).
  - Acceptance: no cycle over `src/` + `index.ts`; no `src/**/index.ts` barrel exists.
  - Verify: scripted DFS/`madge`-style check over relative imports; `find src -name index.ts`
    → nothing
  - Files: —

- [x] **T4.10 Move `test/extension.test.ts` → `test/pi/extension.test.ts`** ✅ `7d2a88a`: proven a **pure rename** — `diff 10c77a7:test/extension.test.ts test/pi/extension.test.ts` shows exactly 7 lines changed, all import specifiers gaining one `../`. 18 `test(` cases intact, ran alone → 18 pass / 0 fail. Local `renderAck` helper preserved at line 212. `globSync(...).length === 15`; per-folder `test` 2, `test/pi` 1, `test/present` 2, `test/herdr` 2, `test/config` 3, `test/children` 5.
  - Acceptance: its 18 cases still present; `../index.ts`→`../../index.ts` and its src imports
    re-pointed one level deeper; the local `renderAck` helper preserved. `src/pi/` now exists,
    so the mirror is honest.
  - Verify: `npm test` → 241+N / 0 fail; `globSync(...).length === 15`
  - Files: `test/pi/extension.test.ts`

- [x] **T4.11 Checkpoint CP4** ✅ passed independently at `7d2a88a`: typecheck exit 0; `npm test` → **246 pass / 0 fail** (exact count re-read, not the exit code); `globSync` → 15; `wc -l index.ts` → 82; DAG acyclic (31 nodes / 0 cycles, re-derived by orchestrator → 73 edges); `npm run smoke:tool` exit 0 with a real spawn (`w7:p71`), the steer arriving 4.1s after `execute()`, and the pane reaped. `git show --stat` → only `index.ts`, `src/pi/tool.ts`, `test/{ => pi}/extension.test.ts`; the three planning files stayed untracked. **Literal preservation:** all 36 distinct literals from the pre-M4c `index.ts` still present — the 8 that changed form are import specifiers re-rooted for `src/pi/tool.ts` (`./src/x.ts` → `../x.ts`), each counterpart confirmed, plus `watch-batch` as same-dir `./watch-batch.ts`. **Deviation:** M4 shipped as three commits (`deab471` M4a, `10c77a7` M4b, `7d2a88a` M4c) rather than the single `M4:` commit named below; scope per commit is recorded above and no commit was amended.
  - Acceptance: clean typecheck; `npm test` → **241+N / 0 fail**; DAG; `index.ts ≤ 120`;
    `npm run smoke:tool` passes. Commit `M4: decompose index.ts into src/pi and src/present`.
  - Verify: `npm run typecheck && npm test && npm run smoke:tool`

---

## M5 — `docs-refresh`

- [x] **T5.1 Update `README.md` path citations** ✅ `2e93f02`: `README.md:115` `src/config.ts` → `src/config/config.ts` (the only citation in the file, and it is inside an example task prompt). Verified citation-only: de-citing the whole file (every `src/…`/`test/…`/`index.ts:NN` token → `<CITE>`) makes the pre-M5 and post-M5 revisions **byte-identical**, so no prose moved. `README.md:14`, `:224`, `:252` carry no `src/…:NN` citation and were correctly left alone.
  - Acceptance: every `src/…:NN` reference at `README.md:14,115,224,252` points at a file that
    exists after the move (line numbers may be updated to the new anchors).
  - Verify: `rg -o "src/[a-z/-]+\.ts" README.md | sort -u` — every path exists on disk
  - Files: `README.md`

- [x] **T5.2 Update `docs/spec-*.md` citations** ✅ `2e93f02` + `8c25475`: 60 citation tokens re-pointed across `spec-project-config` (38), `spec-report-tool` (14), `spec-panel-layout` (11) and `spec-child-preflight-failure` (4). Line-number rule applied as specified: pure-`git mv` modules and all test files keep their `:NN` (bodies are byte-identical); the four M2-split modules have numbers re-derived by symbol — e.g. `src/spawn.ts:181`→`src/children/spawn.ts:40`, `src/launch.ts:139`→`src/children/task-markdown.ts:15`, `src/launch.ts:257`→`src/children/launch-script.ts:125`, `src/launch.ts:208-219`→`src/children/launch-script.ts:68-79`, `src/spawn.ts:267`→`src/children/spawn.ts:170`. Verified citation-only by whole-file de-citing: `spec-panel-layout`, `spec-project-config` and `spec-child-preflight-failure` are **byte-identical** pre/post M5 once citation tokens are masked; `spec-report-tool` differs only by one brace-glob expansion (`test/{child,…}` → `test/{children/child,…}`). `tasks/archive/*` untouched.
  - One number **dropped, not guessed**: `docs/spec-report-tool.md:34` cited `src/child.ts:112` for the symbol `tinysubagent_done`, which exists nowhere in the tree and never appears in `git log -S` history — the spec itself documents it as "gone". The path is re-pointed and the sentence's own symbol name retained.
  - **Cross-reference restoration (`8c25475`):** T5.3's 27-line insertion into `intent.md` shifted every later line by +28, corrupting two citations in `spec-project-config.md` that M5 had not caught (`docs/intent.md:82`→`:110`; `:66-86`→`:66-74`, `:103-114`). Verified the shift at four anchors (old 75→103, 80→108, 82→110, 86→114) rather than assuming it.
  - Acceptance: the `src/…:NN` references in `docs/spec-project-config.md`,
    `docs/spec-report-tool.md`, `docs/spec-panel-layout.md`,
    `docs/spec-child-preflight-failure.md` and `docs/intent.md:69` re-pointed to the new layout.
    **Prose and decisions unchanged** — citations only. `tasks/archive/*` left frozen.
  - Verify: `rg -o "\bsrc/[a-z0-9/-]+\.ts" docs/ | sort -u` — every path exists on disk
  - Files: `docs/spec-*.md`, `docs/intent.md`

- [x] **T5.3 Add a "Repository layout" section to `docs/intent.md`** ✅ `2e93f02`: section added at `docs/intent.md:76-102` (26 lines), between `## Constraints` (57-75) and `## Out of scope` (103). States the layer rule for `index.ts` (wiring only), the `src/` root leaves (`paths.ts`, `types.ts`, `tool-patterns.ts`) and each role folder (`config/`, `herdr/`, `children/`, `present/`, `pi/`); both invariants explicitly — `childExtensionPath` contractual (a wrong value loads no child extension, so pi gets no `subagent_report`/`agent_settled` and every real child hangs **while the suite stays green**), and `buildLaunchPaths` as the single sidecar-path source; plus that `src/paths.ts` is the only `import.meta.url` reader and the only home for the `"src"`/`"herdr-plugin"`/`"child.ts"` literals. The superseded `:69` constraint ("not a module tree") was reconciled in the same commit and named in the commit body — the **one** intentional prose edit of M5.
  - Acceptance: states the layer rule (root `types.ts`/`tool-patterns.ts`/`paths.ts`; `config/`
    discovery; `herdr/` transport; `children/` child lifecycle; `present/` output shaping;
    `pi/` pi lifecycle glue; `index.ts` wiring only) and the two invariants a future editor must
    not break: `childExtensionPath` is contractual (`-e` target), and `buildLaunchPaths` is the
    single source of sidecar paths.
  - Verify: read-back review
  - Files: `docs/intent.md`

- [x] **T5.4 Checkpoint CP5 — full gate** ✅ passed independently by the orchestrator at `8c25475` (not on worker report): typecheck clean; `npm test` → **246 pass / 0 fail**; `globSync` → 15; **all five smokes re-run by me and PASS** — `smoke` (1 completed, 0 failed, all reported together), `smoke:tool`, `smoke:layout` (orchestrator at 3/5, equal sub-heights, all panes closed), `smoke:interrupt`, `smoke:provider-error`. Citation existence re-checked: **0 of 23 unique cited paths missing on disk**. Success criteria 1–11 all pass, with the criterion-5 exception list acknowledged.
  - Acceptance: every success criterion 1–11 in `docs/spec-code-layout.md` verified, with the
    criterion-5 exception list acknowledged (the three pre-existing >200-line modules and the
    eight >200-line test files stay whole).
  - Verify: `npm run typecheck && npm test && npm run smoke && npm run smoke:tool &&
    npm run smoke:layout && npm run smoke:interrupt && npm run smoke:provider-error`
  - Files: —

---

## Final acceptance sweep

- [x] `index.ts` ≤ 120 lines, wiring only — **82 lines**, no schema/TUI/`execute`/`waitForSubagent`
- [x] No file **created or split** by this refactor exceeds 200 lines — max is `src/pi/tool.ts` at exactly 200; the only >200 files are the 4 documented production exceptions + 8 pre-existing test files
- [x] `rg -n "import\.meta\.url" src/ index.ts` → `src/paths.ts` only — `src/paths.ts:4` (doc) and `:40` (code)
- [x] `rg -n '"src"|"herdr-plugin"|"child\.ts"' src/` → no path literal outside `src/paths.ts` — only `src/paths.ts:43,51,58`
- [x] No `src/**/index.ts`; dependency graph acyclic — re-derived independently: 31 nodes / 73 edges / **0 cycles**
- [x] No folder shares a name with a file inside it, except `src/config/config.ts` — verified by scan
- [x] `npm test` → 241+N pass / **0 fail**; `globSync(...).length === 15` — 246 / 0 / 15
- [x] All five smoke commands pass (both real-child smokes included) — re-run by the orchestrator at `8c25475`
- [x] Every pre-existing test case still present with its assertions intact — 241 at the `87dd773` baseline + 5 new `paths` cases = **246**; every module's per-file count re-checked at its checkpoint, and every test-file relocation was proven a pure rename (import lines only)
- [x] No `@ts-ignore` / `@ts-expect-error` / `.skip` added anywhere — `rg` over `src/`, `test/`, `index.ts` → none
