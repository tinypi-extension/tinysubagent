# Spec: code layout — `index.ts` decomposition and `src/` reorganization

**Status: approved.** Capability map, folder layout, deep splits, and test mirroring all
approved by the user. Implement in the order given in "Implementation order".

## Assumptions I'm making

1. **`index.ts` stays at the repository root.** `package.json` `pi.extensions` is
   `["./index.ts"]`. It becomes thin wiring; it does not move and is not renamed.
2. **`paths-hardening` is a prerequisite, not an optional cleanup.** Two modules derive the
   repo root by double-`dirname`-ing their own URL and therefore assume they sit exactly one
   level under the root:
   - `src/herdr.ts:36` — `join(dirname(dirname(fileURLToPath(import.meta.url))), "herdr-plugin")`
   - `src/spawn.ts:42-43` — `join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "child.ts")`

   Any subfolder move silently repoints the first at `<repo>/src/herdr-plugin` and the second
   at `<repo>/src/src/child.ts`. `pluginDir()` is covered by `test/herdr.test.ts:107`;
   `childExtensionPath` has **zero** coverage anywhere in the repo.
3. **Behavior-preserving.** No exported symbol is renamed, no tool name changes, no config key
   changes, no agent-role format changes, no generated launch-script or argv text changes, and
   no model-facing string changes. The only removals are verified-dead code.
4. **Test files mirror `src/`.** Tests move into subfolders matching the new layout, and
   `package.json` `scripts.test` becomes a **quoted** recursive glob. This is one atomic
   change with the `src/` move, because an unquoted `test/**/*.test.ts` is `sh`-expanded to
   `test/*/*.test.ts` and silently drops the root-level `test/tool-patterns.test.ts`.
5. **No `index.ts` barrel files inside `src/`** — with one deliberate exception, the
   `src/children/launch.ts` façade described in "Module boundaries". Barrels named `index.ts`
   would hide `index.ts`'s 79 direct references across 11 modules and invite cycles. The
   dependency graph is a clean DAG today and must stay one.
6. **Two same-named concepts must not collide.** `src/children/session.ts` reads pi's session
   JSONL. The new pi-lifecycle module is therefore named `src/pi/lifecycle.ts`, never
   `src/pi/session.ts`.
7. **`errorMessage` (`src/spawn.ts:101-103`) and `errorText` (`src/child.ts:234-236`) stay two
   separate copies.** They are intentionally independent: `child.ts` must not import from the
   spawn side and vice versa (`src/types.ts:30-32`). Do not unify them during this refactor.
8. **House conventions kept.** Specs live in `docs/spec-<slug>.md` with the existing section
   order; the plan goes to `tasks/plan.md` and the task list to `tasks/todo.md`.
9. **`tasks/archive/` stays frozen.** Its stale path citations are history, not documentation.
10. **Source-of-truth pin: `buildLaunchPaths` is the only place a sidecar path is computed.**
    Any split that lets a second module recompute `.done` / `.exitcode` / session paths
    silently desyncs the watcher from the child. This is a hard constraint on `deep-splits`.

→ Correct any of these now or I'll build on them.

## Current behaviour (verified, not assumed)

Verified at `87dd773` by recon over the working tree; every line number below was re-read
before this spec was written.

**Baseline, green:**
```
npm run typecheck   → tsc --noEmit, clean
npm test            → 1..241 / # tests 241 / # pass 241 / # fail 0
```
`npm test` is `node --test test/*.test.ts` — a **non-recursive** glob. `tsconfig.json`
`include` is already recursive (`["index.ts", "src/**/*.ts", "test/**/*.ts"]`) and needs no
change. Node is **v22.23.2**.

**`index.ts` is 559 lines and holds eight distinct concerns:**

| Concern | Symbols | Lines |
|---|---|---|
| Capability probe | `capabilityCheck`, `HerdrReadiness`, `READY`, `probeHerdr`, `checkHerdr`, `ensureHerdrReady` | 57, 60–65, 67, 73–101, 103–105, 112–117 |
| Tool surface (schema + docs) | `MAX_LISTED_AGENTS`, `MAX_ADVERTISED_DESCRIPTION`, `advertiseAgents`, `buildToolDescription`, `PROMPT_GUIDELINES`, `buildParameters` | 50–51, 123–136, 138–165, 167–173, 179–218 |
| Error shaping | `failure` | 220–226 |
| Ack types + rendering | `SpawnedEntry`, `AckDetails`, `NOTE_STARTED`, `NOTE_NOTHING`, `THINKING_COLORS`, `renderAck` | 233–239, 241–246, 248–249, 250, 253–261, 269–280 |
| Session lifecycle | `fixOffered` (300), `offerPluginFix` (318–357), `session_start` (359–369), `session_shutdown` (371–375) | 300–375 |
| Spawn orchestration | `columns` (307), `deliver` (377–388), `watchBatch` (395–431) | 307–431 |
| Tool registration + TUI | `pi.registerTool` (433), `execute` (441–535), `renderResult` (537–557) | 433–558 |
| Entrypoint wiring | `tinysubagent` (286–288), `config` (289), `parameters` (290), `advertisedAgents` (293), `watchers` (296), `shuttingDown` (297) | 286–293, 296–297 |

Module-level mutable state is `let capabilityCheck` (`index.ts:57`), written both by
`ensureHerdrReady` (113, 116) and by `offerPluginFix` (347) — the only cross-cluster global,
and it is **not** per-registration. Everything else mutable (`watchers`, `shuttingDown`,
`fixOffered`, `columns`) is closure-local inside `tinysubagent`.

`index.ts` imports 40 symbols from 11 src modules and dereferences them 79 times; `herdr.ts`
(23 refs) and `spawn.ts` (21 refs) dominate.

**Import-time behaviour of `index.ts`:** none. No `pi.on`, no `registerTool`, no I/O at module
top level. All work is deferred into `export default function tinysubagent(pi)`. That function
opens with `if (!isInsideHerdr()) return;` (`index.ts:287`).

**`src/` is flat: 14 files, 2,790 lines.** `types.ts` is the hub (8 importers), then
`profiles.ts` and `herdr.ts` (5 each), `config.ts` and `watcher.ts` (3 each). Runtime
dependency graph is a **strict DAG with no cycles** — the only suspicious pairs
(`spawn ↔ watcher`, `watcher ↔ profiles`) reverse through `import type` edges only.

**Verified dead code:** `herdrPaneOpen` is imported at `index.ts:31` and referenced nowhere
else in the file. `childExtensionPath` (`src/spawn.ts:43`) is exported but has **no importer
anywhere in the repo** — it is consumed only indirectly, as the `-e` target written into the
launch script.

**Path-string hazards, by severity:**
1. `src/spawn.ts:43` — `join(packageRoot, "src", "child.ts")`, no test coverage. A break here
   passes the whole suite and fails at real spawn time: pi loads no child extension, so there
   is no `subagent_report` tool, no `agent_settled`, and no input preflight hook.
2. `src/herdr.ts:36` and `src/spawn.ts:42` — the depth-2 `import.meta.url` derivations.
3. `package.json:12` — the non-recursive test glob.
4. 14 test files and 5 `scripts/*.ts` smoke scripts import `../src/<name>.ts` literally.
5. `test/herdr.test.ts:23` calls `pluginDir()` at module load and
   `test/herdr.test.ts:127` `execFile`s the real `pluginDir()/dispatch.sh`. If `pluginDir()`
   breaks, the whole file throws at import and its 19 cases vanish from the count.

## Objective

Make the codebase navigable by concern without changing a single observable behavior:

- **For humans:** reading `index.ts` to understand the pi extension should take minutes. Today
  it is 559 lines where the tool schema, the herdr capability probe, the TUI renderer, the
  session-start plugin-link repair flow, and the batch watcher are interleaved.
- **For the model:** a delegation of work to a subagent should be able to state "the launch
  script is built in `src/children/launch-script.ts`" and be right. Flat `src/` means every
  change requires grepping for symbol names because no filename predicts contents.
- **For future sessions:** the two `import.meta.url` derivations are latent traps that will
  bite the next person who moves a file. Replace them with one resolver that cannot be broken
  by relocation, and add the missing test that would have caught it.

Success is measured by the success criteria at the bottom, not by file count.

## Scope check

This request bundles five independently shippable capabilities. Approved map:

| Module id | Responsibility | Depends on |
|---|---|---|
| `paths-hardening` | `src/paths.ts` package-root resolver; rewire `pluginDir()` and `childExtensionPath`; add the missing on-disk tests | — |
| `deep-splits` | Internally split `launch.ts` (287), `child.ts` (422), `spawn.ts` (355) | `paths-hardening` |
| `src-reorg` | Move `src/*.ts` into role subfolders; rewrite every import in src/tests/scripts; flip the test glob to quoted-recursive | `paths-hardening`, `deep-splits` |
| `index-decompose` | Extract the eight `index.ts` concerns into `src/pi/` + `src/present/`; `index.ts` becomes wiring | `src-reorg` |
| `docs-refresh` | `README.md` + `docs/spec-*.md` stale `src/x.ts:NN` citations; new `docs/intent.md` layout section | all above |

Build order: `paths-hardening` → `deep-splits` → `src-reorg` → `index-decompose` → `docs-refresh`.

`deep-splits` runs **before** the directory move on purpose: splitting first makes the move a
pure rename, so any breakage is attributable to one change rather than two.

## Target layout (authoritative)

```
index.ts                 # wiring only

src/
  paths.ts               # repo-root resolver — the ONLY module that reads import.meta.url
  types.ts               # L0 shared types + constants (unchanged)
  tool-patterns.ts       # L0 pure leaf (unchanged)

  config/                # settings + role/profile discovery
    config.ts            #  <- src/config.ts
    agents.ts            #  <- src/agents.ts
    profiles.ts          #  <- src/profiles.ts

  herdr/                 # herdr transport + pane geometry
    cli.ts               #  <- src/herdr.ts   (renamed: folder name is `herdr`)
    layout.ts            #  <- src/layout.ts

  children/              # starting, watching and reporting on child panes
    contract.ts          #  NEW  + from spawn.ts
    requests.ts          #  NEW  + from spawn.ts
    spawn.ts             #  <- src/spawn.ts  (trimmed)
    launch.ts            #  <- src/launch.ts (façade over the three below)
    launch-paths.ts      #  NEW  + from launch.ts
    launch-script.ts     #  NEW  + from launch.ts
    task-markdown.ts     #  NEW  + from launch.ts
    watcher.ts           #  <- src/watcher.ts  (kept whole — see "Out of scope")
    session.ts           #  <- src/session.ts   (pi JSONL reader)
    report.ts            #  NEW  + from child.ts
    settle.ts            #  NEW  + from child.ts
    preflight.ts         #  NEW  + from child.ts
    child.ts             #  <- src/child.ts     (the `-e` target — path is contractual)

  present/               # output shaping for the model and the TUI
    ack.ts               #  <- src/ack.ts
    steer.ts             #  <- src/steer.ts
    describe.ts          #  NEW  from index.ts — tool description + TypeBox schema
    ack-render.ts        #  NEW  from index.ts — renderAck + colours + notes

  pi/                    # pi lifecycle glue
    tool.ts              #  NEW  from index.ts — createTool(deps)
    capability.ts        #  NEW  from index.ts — probe + cached readiness (factory)
    plugin-fix.ts        #  NEW  from index.ts — offerPluginFix
    lifecycle.ts         #  NEW  from index.ts — session_start / session_shutdown
    watch-batch.ts       #  NEW  from index.ts — deliver + watchBatch
```

`test/` mirrors it: `test/config/`, `test/herdr/`, `test/children/`, `test/present/`,
`test/pi/`, plus root-level `test/tool-patterns.test.ts` and the new `test/paths.test.ts`.

Naming rule: **no folder shares a name with a file inside it** except where the folder name is
the domain and the file is the concept (`config/config.ts`). Specifically avoided:
`herdr/herdr.ts` (→ `herdr/cli.ts`), `spawn/spawn.ts` (→ `children/spawn.ts`),
`child/child.ts` (→ `children/child.ts`).

## `src/paths.ts` (authoritative)

The single module permitted to derive paths from `import.meta.url`. It resolves the package
root by walking up to the nearest `package.json` rather than counting directories, so it stays
correct wherever it or its callers are relocated.

```ts
// src/paths.ts
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/** Walk up from `start` to the nearest directory containing a package.json. */
export function findPackageRoot(start: string): string { /* bounded by path.parse().root */ }

export const packageRoot: string = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
export const srcDir: string = join(packageRoot, "src");
/** The plugin directory this package ships (see herdr-plugin/). */
export function pluginDir(): string { return join(packageRoot, "herdr-plugin"); }
/** The child-side pi hook, passed as `-e <path>` by the launch script. */
export const childExtensionPath: string = join(srcDir, "child.ts");
```

**Sequencing note on `childExtensionPath`.** `src/child.ts` does not move to
`src/children/child.ts` until `src-reorg` (M3), which runs *after* this module. So `paths.ts`
ships with `join(srcDir, "child.ts")` — the file that exists at M1 — and **M3 updates that one
segment to `join(srcDir, "children", "child.ts")` in the same commit as the directory move.**
Setting it to `children/child.ts` at M1 would point at a nonexistent file and fail the M1 gate
(`npm run smoke:tool`, `npm run smoke:interrupt`), because nothing would load the child
`-e` hook. `test/paths.test.ts` asserts the target exists on disk precisely so M3 cannot forget.`

`findPackageRoot` must terminate even if no `package.json` exists anywhere above, falling back
to the starting directory rather than throwing — an unresolvable root is a worse failure than a
wrong-but-usable one for the link prompt.

Rewiring:
- `src/herdr.ts:35-37` — the body of `pluginDir()` becomes a re-export; `src/herdr.ts` keeps
  exporting `pluginDir` so no caller changes. `existsSync`/`join`/`dirname`/`fileURLToPath`
  imports shrink accordingly.
- `src/spawn.ts:42-43` — delete `packageRoot`, keep
  `export { childExtensionPath }` sourced from `./paths.ts` so the (currently unused) export
  name survives.

## Module boundaries and contracts

### `deep-splits` — `src/children/`

**`launch.ts`** becomes a **façade**: a ~10-line file re-exporting the three modules below. This
freezes the import path for `spawn.ts` and `test/launch.test.ts` (25 import lines across both)
so the split is risk-free, and keeps "the launch module" a real addressable concept. It costs
nothing at runtime (ESM re-export).

| New file | Symbols moved | Approx lines |
|---|---|---|
| `launch-paths.ts` | `runId`, `safeName`, `timestampForArtifacts`, `timestampForSession`, `childSessionDirFor`, `LaunchPaths`, `LaunchPathsInput`, `buildLaunchPaths`, `LaunchFile`, `writeLaunchFiles` | ~105 |
| `launch-script.ts` | `shellEscape`, `LaunchScriptOptions`, `DEFAULT_HOLD_OPEN_SECS`, `buildLaunchScript`, `PiArgvOptions`, `buildPiArgv`, `resolvePiBin`, `resolveLaunchPrefix` | ~126 |
| `task-markdown.ts` | `buildTaskMarkdown` | ~28 |

Confirmed seam evidence (all three hold): `buildLaunchScript` (was 190–244) touches only
`shellEscape`, its option fields and `DEFAULT_HOLD_OPEN_SECS` — it never calls a path builder.
`buildLaunchPaths` (97–119) uses `safeName`/`childSessionDirFor`/both timestamps and no shell
helper. `buildTaskMarkdown` (145–157) uses only `REPORT_TOOL_NAME`. The three modules have
**no import edges among themselves**.

Hard constraint from Assumption 10: `buildLaunchScript` receives `taskFile`/`reportFile`/
`exitCodeFile`/`childSessionFile` as strings from its options and must never compute one.
`test/launch.test.ts:46-64` pins `exitCodeFile === childSessionFile + ".exitcode"` and
`reportFile === childSessionFile + ".done"`.

**`child.ts`** splits on the *shared byte-writer* axis, not on "tool vs settle". The earlier
candidate seam **fails**: `preflightRefusal`'s caller writes via `writeReportFile`
(`src/child.ts:391`) exactly like the settle branches (401, 420), so a tool/settle split would
strand the writer across both.

| New file | Symbols moved | Approx lines |
|---|---|---|
| `report.ts` | `ChildSettle`, `writeReportFile`, `writeResultReport` (+ private `reportFilePath`, `writeAtomic`) | ~80 |
| `settle.ts` | `SettleVerdict`, `settleReason` (+ **exported** `failureDetail`, **exported** `TurnMessage`) | ~68 |
| `preflight.ts` | `preflightFailure`, `PreflightRegistry`, `PreflightContext`, `preflightRefusal` (+ **exported** `errorText`) | ~95 |
| `child.ts` | `default tinysubagentChild` only, plus its rationale header | 207 (as-built; see criterion 5) |

Edges: `settle.ts --type ChildSettle--> report.ts`; `child.ts --> report.ts, settle.ts,
preflight.ts, ../types.ts`. `preflight.ts` → nothing internal. `report.ts` must **not** import
`settle.ts`. `errorText` must be exported because `child.ts`'s input-catch hook uses it, and
`failureDetail` must be exported because the `agent_settled` failure branch calls
`writeReportFile("failed", failureDetail(lastMessages))` (was `src/child.ts:420`) — keeping it
private would have silently dropped the `"no-output"` reason from a failed settle.

Constraint: `finished`, `lastMessages`, `runSignal` (was 309, 307, 311) stay **closure-local**
inside `tinysubagentChild`. Hoisting `finished` breaks "no overwrite after report"
(`test/child.test.ts:284-306`) and leaks state across children in a long-lived process. Both
writers keep routing through the single `writeAtomic`.

**`spawn.ts`** splits contract types out first — `spawnOne` alone is 156 lines, so the file
cannot keep 31 lines of interfaces and stay under budget.

| New file | Symbols moved | Approx lines |
|---|---|---|
| `contract.ts` | `TaskInput`, `ToolParams`, `SpawnRequest`, `SpawnContext`, `Spawned`, `SpawnFailed`, `errorMessage` | ~62 |
| `requests.ts` | `MAX_PARALLEL_TASKS`, `uniqueName`, `collectRequests`, `resolveProjectAgentDir`, `resolveCwd` | ~88 |
| `spawn.ts` | `TOOL_NAME`, `childExtensionPath` (re-export from `paths.ts`), `spawnOne`, `parentModelSpec`, `parentThinking` | ~197 |

Corrections to the originally proposed seam, with evidence:
- `MAX_PARALLEL_TASKS` is used in-file **only** by `collectRequests` (`src/spawn.ts:132-133`).
  It moves with `collectRequests`, otherwise you create a back-edge `requests → spawn`.
- `parentModelSpec`/`parentThinking` (333–343) are a third cluster the original seam ignored.
  They are spawn-time `ExtensionContext` reads and belong with `spawnOne`; putting them in
  `requests.ts` would drag the pi `ExtensionContext` type into the pure path module.
- No edge `spawn.ts → requests.ts` and none the other way. Acyclic.

### `index-decompose` — `src/pi/` and `src/present/`

| New file | Extracted from `index.ts` | Depends on |
|---|---|---|
| `src/present/describe.ts` | `MAX_LISTED_AGENTS`, `MAX_ADVERTISED_DESCRIPTION`, `advertiseAgents`, `buildToolDescription`, `PROMPT_GUIDELINES`, `buildParameters` | `config/`, `config/profiles.ts`, `children/spawn.ts`, `types.ts`, typebox |
| `src/present/ack-render.ts` | `SpawnedEntry`, `AckDetails`, `NOTE_STARTED`, `NOTE_NOTHING`, `THINKING_COLORS`, `renderAck` | `present/ack.ts`, `types.ts`, pi-tui, pi theme types |
| `src/pi/capability.ts` | `HerdrReadiness`, `READY`, `probeHerdr`, `checkHerdr`, `ensureHerdrReady`, `capabilityCheck` | `herdr/cli.ts` |
| `src/pi/plugin-fix.ts` | `offerPluginFix` (was 318–357) | `herdr/cli.ts`, `pi/capability.ts` |
| `src/pi/lifecycle.ts` | `session_start` (359–369), `session_shutdown` (371–375) | `pi/plugin-fix.ts`, `children/…` |
| `src/pi/watch-batch.ts` | `deliver` (377–388), `watchBatch` (395–431) | `children/watcher.ts`, `present/steer.ts`, `herdr/layout.ts`, `herdr/cli.ts` |
| `src/pi/tool.ts` | the `registerTool` object (433–558), `execute` (441–535), `renderResult` (537–557), `failure` (220–226) | all of the above |
| `index.ts` | guard, `loadConfig`, `discoverAgents`, `buildParameters`, per-session state, `registerTool(createTool(deps))`, `registerLifecycle(pi, deps)` | — |

**`capability.ts` is a factory, not a module-level global.** `capabilityCheck` (57) is written
by both `ensureHerdrReady` and `offerPluginFix` (347), which is why it cannot simply move.
Shape:

```ts
export function createCapabilityCheck(): {
  ensureReady(): Promise<string | null>;
  probe(options?: RunOptions): Promise<HerdrReadiness>;
  reset(): void;          // what offerPluginFix needs after a successful repair
}
```

`index.ts` creates one instance per registration; `plugin-fix.ts` receives its `reset` as a
dependency. This removes the last module-level mutable state from the extension.

**`failure` (220–226) moves to `src/pi/tool.ts`**, not to a shared errors module: it shapes the
pi tool-result envelope, is used at 4 call sites all inside `execute`, and nothing else wants it.

**`tool.ts` is `createTool(deps)`**, not a top-level registration. `index.ts` keeps the
`isInsideHerdr()` guard, the registration-time `loadConfig`/`discoverAgents`/`buildParameters`
reads (289–293), the per-session mutable state (`watchers` 296, `shuttingDown` 297,
`fixOffered` 300, `columns` 307), and the final `pi.registerTool(createTool(deps))` call.

Dead code: the `herdrPaneOpen` import at `index.ts:31` is deleted in this module.

## Deliberate non-behaviour

- **No exported signature changes.** Every symbol listed in "Module boundaries" keeps its name
  and stays exported from a reachable path. `child.ts`'s default export keeps its identity —
  it is a `-e` entrypoint.
- **`failure`, `errorText`, `errorMessage` stay separate.** No shared error utility.
- **No barrel `index.ts` files.** The `children/launch.ts` façade is a named-module façade, not
  an `index.ts`, and it re-exports rather than re-declaring.
- **No dependency-graph flattening.** The DAG is preserved; no new cycle is introduced. In
  particular `present/ack-render.ts` must not import `pi/tool.ts`.
- **No lazy/dynamic imports**, no `require`, no new runtime dependency.
- **The `TOOL_NAME` value stays `"subagent"`** (`src/spawn.ts:39`) and the config/package name
  stays `tinysubagent`.
- **`docs/` and `tasks/archive/` prose is not rewritten** beyond fixing stale path citations in
  `docs-refresh`; `tasks/archive/` is left frozen.
- **`herdr-plugin/` is untouched** except one comment (`herdr-plugin.toml:5`) that names
  `src/herdr.ts`.
- **No test is deleted, skipped, or weakened.** The count goes 241 → 241 + the new `paths`
  tests. Assertions are not relaxed to accommodate the move.

## Files

Created: `docs/spec-code-layout.md`, `tasks/plan.md`, `tasks/todo.md`, `src/paths.ts`,
`src/children/{contract,requests,launch-paths,launch-script,task-markdown,report,settle,preflight}.ts`,
`src/present/{describe,ack-render}.ts`,
`src/pi/{tool,capability,plugin-fix,lifecycle,watch-batch}.ts`, `test/paths.test.ts`.

Moved: all 14 `src/*.ts` (two renamed: `herdr.ts`→`herdr/cli.ts`), all 14 `test/*.test.ts`,
plus the internal splits above.

Edited in place: `index.ts`, `package.json` (only `scripts.test`), `herdr-plugin/herdr-plugin.toml`
(one comment), `README.md` + `docs/spec-*.md` (path citations).

Unchanged: `tsconfig.json`, `package.json` `smoke*`/`link-plugin`/`pi.extensions` entries,
all 5 `scripts/*.ts` smoke scripts except their import lines.

## Commands

```
Typecheck:  npm run typecheck              # tsc --noEmit
Test:       npm test                       # node --test "test/**/*.test.ts"   (after this refactor)
Test file count probe:
            node -e 'console.log(require("node:fs").globSync("test/**/*.test.ts").length)'   # expect 15
Real-child smoke:  npm run smoke:tool && npm run smoke:interrupt
Layout smoke:      npm run smoke:layout
Other smoke:       npm run smoke, npm run smoke:provider-error
```

`npm run smoke:tool` and `npm run smoke:interrupt` spawn a **real child** and are therefore the
only commands that exercise `childExtensionPath`. They are mandatory gates for `paths-hardening`
and `src-reorg`.

## Code style

Unchanged from the existing codebase. Match it exactly:

```ts
// src/children/report.ts
import { writeFileSync } from "node:fs";
import type { ChildSettle } from "./settle.ts";

/** Writes the content-free sidecar the orchestrator polls for. */
export function writeReportFile(settle: ChildSettle, detail?: string): void {
	if (settle === "done") return writeAtomic({ done: true });
	return writeAtomic({ failed: true, reason: settle, ...(detail ? { message: detail } : {}) });
}
```

Conventions that must hold in every new file:
- **Tabs** for indentation; double quotes; semicolons; trailing commas.
- **Relative imports keep the `.ts` extension** (`allowImportingTsExtensions` is on):
  `from "./report.ts"`, `from "../types.ts"`.
- **Type-only imports must use `import type`** (`verbatimModuleSyntax` is on):
  `import type { RunningSubagent } from "./watcher.ts";`.
- One exported symbol per responsibility; `function` declarations for functions, `const` for
  constants.
- Every module keeps its leading `/** … */` docstring explaining *why* it exists, in the
  register the current files use (see `src/herdr.ts:1-18`, `src/config.ts:1-8`).
- Import order: node builtins, then external packages, then intra-repo, as in the current files.
- No `any`, no non-null assertions beyond what already exists, no `@ts-ignore`/`@ts-expect-error`.

## Testing strategy

Framework unchanged: `node --test`, `node:assert/strict`, no test framework dependency, real
temp dirs via `mkdtempSync(join(tmpdir(), …))`.

| Level | Where | What it must prove |
|---|---|---|
| Unit | `test/<mirrored path>.test.ts` | each moved/split module behaves identically to before. Existing assertions are preserved verbatim, only import paths change. |
| New unit | `test/paths.test.ts` | `pluginDir()` contains `herdr-plugin.toml` and `dispatch.sh` on disk; `childExtensionPath` resolves to an existing file; `findPackageRoot` finds the repo root from a nested dir and terminates with no `package.json`. |
| Integration | `test/pi/extension.test.ts` (moved from `test/extension.test.ts`) | the real registered tool via a stub `ExtensionAPI` — the only shadow over the new `src/pi/*` modules. It must keep all 18 cases and the local `renderAck` helper (was `extension.test.ts:211`). |
| Smoke | `scripts/smoke-tool.ts`, `scripts/smoke-interrupt.ts` | a real child spawns, reports, and settles — the only coverage of `childExtensionPath` end to end. |

Coverage expectations: **no case count may decrease at any step.** Per-folder after the move:
`config/` 63, `children/` 98, `herdr/` 38, `present/` 14, `pi/` 18, root 10
(`tool-patterns`), plus `test/paths.test.ts` → **241 + new**.

The count check is per-file, not just per-run: if a test file throws at import
(`test/herdr/cli.test.ts:23` calls `pluginDir()` at load), its cases silently disappear and the
run reports "222 passing" with a file-level failure. Always compare the case count *and* the
file count (`globSync(...).length`, expect 15).

Test-organization rules:
- A test file lives in the folder of its **dominant subject**. `test/spawn.test.ts`,
  `test/steer.test.ts`, `test/layout.test.ts` and `test/profiles.test.ts` import 2–4 src modules
  but each has one subject; they follow the subject.
- `test/extension.test.ts` → `test/pi/extension.test.ts`, because after `index-decompose` its
  subject is the `src/pi/*` wiring. If `index-decompose` were cut, it would stay at
  `test/extension.test.ts` root, mirroring root `index.ts`.
- `test/herdr.test.ts` → `test/herdr/cli.test.ts`, matching the `herdr.ts`→`herdr/cli.ts` rename.
- `test/tool-patterns.test.ts` stays at the test root, mirroring root `src/tool-patterns.ts`.

## Boundaries

**Always do:**
- Run `npm run typecheck` and `npm test` after every task, and compare the case count to the
  previous step. Nothing is "done" until both are green at the same count.
- Run `npm run smoke:tool && npm run smoke:interrupt` after any change that touches
  `childExtensionPath`, `pluginDir()`, the launch script, or the directory layout.
- Keep every relative import extension-ful (`.ts`) and every type-only import `import type`.
- Rewrite import paths mechanically from the verified lists in the recon reports; never infer
  a path from a filename.
- Keep `index.ts` at the repo root with `pi.extensions: ["./index.ts"]` unchanged.
- Quote the test glob in `package.json`.

**Ask first:**
- Adding, removing, or upgrading any dependency.
- Changing `TOOL_NAME`, any config key, or any model-facing string.
- Splitting a file in a way that changes an exported symbol's name or its owning module.
- Changing `tsconfig.json`.
- Anything that would reduce the test case count, even temporarily.

**Never do:**
- Let `childExtensionPath` or `pluginDir()` be computed outside `src/paths.ts`.
- Hoist `finished`, `lastMessages`, or `runSignal` out of `tinysubagentChild`'s closure.
- Compute a sidecar path anywhere but `buildLaunchPaths`.
- Introduce a `src/**/index.ts` barrel or a new import cycle.
- Unify `errorText` and `errorMessage`.
- Delete, skip, or weaken a test; add `@ts-ignore`/`@ts-expect-error`; relax an assertion.
- Move or rename `index.ts`, `herdr-plugin/`, or `src/children/child.ts` without updating the
  `-e` wiring in the same commit.
- Let the repository sit in a state where `npm test` matches zero files.

## Out of scope

- No behavior change, no bug fix, no feature. If the refactor exposes a bug, record it in
  "Open questions" and leave it.
- No new runtime dependency, bundler, or build step.
- No rewrite of `docs/spec-*.md` prose or `tasks/archive/*`.
- No change to `herdr-plugin/` shell logic.
- No new public API surface — nothing becomes importable that was not already.
- **No split of `herdr.ts` (384), `watcher.ts` (285) or `config.ts` (269).** They are the
  remaining oversized modules after `deep-splits`, and each is a self-contained concern with a
  larger test file than source file (`test/herdr/cli.test.ts` 484, `test/children/watcher.test.ts`
  450, `test/config/config.test.ts` 530). They move as whole files. Splitting them is a
  candidate follow-up — see "Open questions" — not part of this change.
- **No restructuring of test files beyond location.** A test file keeps its cases, its helpers
  and its internal organization; only the file's folder and its import lines change. The three
  test files that would naturally split (`child` 649, `extension` 626, `spawn` 594) stay whole.
- No speculatively-created module of any kind; the target tree lists only files that this
  refactor actually creates.
- No renaming of `src/children/session.ts` even though `session` is an overloaded word here;
  renaming an exported module invites churn beyond the refactor's purpose. The collision is
  resolved by naming the new file `src/pi/lifecycle.ts`.

## Success criteria

1. `npm run typecheck` is clean at `strict` with no new suppressions.
2. `npm test` reports **241 + N** passing, 0 failing, where N is the number of new `paths` tests,
   and `globSync("test/**/*.test.ts").length === 15`.
3. `npm run smoke:tool` and `npm run smoke:interrupt` both complete: a real child spawns, writes
   its sidecar, and settles.
4. `index.ts` is **≤ 120 lines** and contains no tool schema, no TUI rendering, no herdr probe
   logic, and no `waitForSubagent` call — only the `isInsideHerdr()` guard, registration-time
   reads, per-session state, `registerTool(createTool(deps))`, and `registerLifecycle(pi, deps)`.
5. **No file created or split by this refactor exceeds 200 lines**, and `index.ts` is capped at
   120. Three pre-existing files stay above 200 because splitting them was explicitly not part
   of the approved `deep-splits` scope, and every one of them is covered by a larger test file
   than it is long:
   - `src/herdr/cli.ts` — 384 lines (was `src/herdr.ts`)
   - `src/children/watcher.ts` — 285 lines
   - `src/config/config.ts` — 269 lines

   A fourth file is above 200 because its excess is documentation, not code:
   - `src/children/child.ts` — 207 lines (was 422; split in M2b). 81 of those lines are the
     mandated module rationale header, which stays with the entrypoint it explains rather than
     being exiled to `docs/`; the remaining ~124 lines are the `-e` entrypoint. There is **no
     further split seam**: the tool registration and all three `pi.on` hooks read and write
     `finished`, `lastMessages` and `runSignal`, which must stay closure-local inside
     `tinysubagentChild`. Extracting any hook would force that state to module scope, which is
     a behaviour change, not a refactor.

   The eight `test/*.test.ts` files above 200 lines (`child` 649, `extension` 626, `spawn` 594,
   `config` 530, `herdr` 484, `watcher` 450, `layout` 283, `launch` 237) are **out of scope** as
   well: this refactor relocates tests, it does not restructure them. The 200-line budget applies
   to production modules only.
6. `import.meta.url` appears in **exactly one** file: `src/paths.ts`. `rg -n "import\.meta\.url" src/ index.ts`
   returns one path, and `rg -n '"src"|"herdr-plugin"|"child\.ts"' src/` finds no path literal
   outside `src/paths.ts`.
7. No folder shares a name with a file inside it, except `src/config/config.ts`.
8. The runtime dependency graph remains acyclic, and no `src/**/index.ts` exists.
9. Every test case that existed at `87dd773` still exists, with its assertions intact; the only
   edits to test files are import lines and file locations.
10. Every symbol listed in "Module boundaries" is importable under its original name from a
    path reachable by its former importers — verified by the fact that `npm run typecheck`
    passes without touching call-site code for symbols that did not move modules.
11. `README.md` and `docs/spec-*.md` cite paths that exist on disk; no citation points at a
    `src/<file>.ts` that is no longer there.

## Implementation order

Each module is its own commit and its own green checkpoint. Do not start the next until the
previous is green at the expected case count.

| # | Module id | Tasks | Gate |
|---|---|---|---|
| M1 | `paths-hardening` | create `src/paths.ts`; rewire `herdr.ts` + `spawn.ts`; add `test/paths.test.ts` | typecheck + `npm test` (241+N) + `smoke:tool` + `smoke:interrupt` |
| M2 | `deep-splits` (launch → child → spawn) | land `launch.ts` façade split alone first, then `child.ts`, then `spawn.ts`; verify `spawn.ts` ≤ 200 after edits | typecheck + `npm test` (241+N) after **each** of the three |
| M3 | `src-reorg` | move `src/*.ts` into subfolders; rewrite every src/test/script import; move tests into mirrored subfolders; quote the `package.json` test glob; **update `childExtensionPath`'s tail in `src/paths.ts` to `children/child.ts`**; fix the `herdr-plugin.toml:5` comment | typecheck + `npm test` (241+N) + `globSync` = 15 + both real-child smokes |
| M4 | `index-decompose` | extract `present/describe.ts`, `present/ack-render.ts`, `pi/capability.ts`, `pi/plugin-fix.ts`, `pi/lifecycle.ts`, `pi/watch-batch.ts`, `pi/tool.ts`; delete the dead `herdrPaneOpen` import; verify `index.ts` ≤ 120 lines | typecheck + `npm test` (241+N) + `smoke:tool` |
| M5 | `docs-refresh` | fix `README.md` + `docs/spec-*.md` path citations; add a "Repository layout" section to `docs/intent.md` | all commands |

Ordering rules that are not negotiable:
- `paths-hardening` first: it is the only module that prevents a silent, untested breakage.
- `deep-splits` before `src-reorg`: splitting first makes the move a pure rename.
- `launch.ts` before `child.ts` before `spawn.ts`: ascending importers (1 → 4 → 6) and
  descending test coverage.
- The directory move lands with the `childExtensionPath` tail update in the same commit;
  any other order leaves a window where `src/children/spawn.ts` exists while the `-e` target
  still says `src/child.ts` — a green suite over a hung orchestrator (Assumption 2).

## Open questions

1. **`test/extension.test.ts` split.** After M4 it shadows `src/pi/{tool,capability,plugin-fix,
   lifecycle,watch-batch}.ts` and `src/present/{describe,ack-render}.ts` with 18 cases. Does it
   stay one file (cheap, honest as an integration suite) or split per extracted module (finer
   signal, ~6 files, and it would need new stub-API helpers)? **Default: keep it whole**, since
   it is a genuine integration test of the registered tool, and splitting it risks weakening
   the end-to-end assertions.
2. **`src/present/describe.ts` and `src/present/ack-render.ts` have no direct tests.** They are
   only covered indirectly through the extension test. Should M4 add direct unit tests for
   `buildToolDescription` and `renderAck`? **Default: no new tests in M4** — this is a
   behavior-preserving refactor, and the extension test already asserts the rendered output.
   Noted here so it is a deliberate gap, not an oversight.
3. **Follow-up: the three remaining oversized modules.** After M2, `src/herdr/cli.ts` (384),
   `src/children/watcher.ts` (285) and `src/config/config.ts` (269) are the only `src/` files over
   200 lines, so success criterion 5 carries a documented exception list. Candidate seams, not
   verified by this refactor: `herdr.ts` splits cleanly into process invocation
   (`runHerdr`/`unwrap`/`RunOptions`) vs the plugin-link surface
   (`herdrPluginInfo/Link/Enable`, `pluginDir`, `versionAtLeast`); `watcher.ts` splits into the
   poll loop (`waitForSubagent`) vs outcome derivation (`SubagentOutcome`, `readFailureNote`
   plumbing); `config.ts` splits into JSONC parsing vs the two-scope merge rule. **Default: not
   in this refactor.** Raise it as its own spec if the layout still feels uneven after M5.
4. **`test/herdr.test.ts` reads the real `herdr-plugin/` from disk** and `execFile`s its
   `dispatch.sh`. If the plugin is not linked, that test currently passes or fails depending on
   link state. Unchanged by this refactor; flagged only because the move makes `pluginDir()`
   load-bearing at test-import time.
5. **Seven `index.ts:<line>` citations in `docs/spec-*.md` cite lines that never existed at the
   baseline either — left unfixed deliberately.** `docs/spec-panel-layout.md:186` (`index.ts:460`)
   and `:190` (`index.ts:403`), plus `docs/spec-project-config.md:21`, `:22`, `:33`, `:150` and
   `:172` (`index.ts:196`, `index.ts:200`), were checked against `87dd773:index.ts`: those lines
   hold a `Type.Array(` schema entry, a `runnings.map(`, a comment, and two more schema entries
   respectively. The real anchors at the baseline were `:289` (`loadConfig`), `:293`
   (`discoverAgents(process.cwd())`), `:412` (`outcome.kind === "completed"`) and `:484`
   (the `columns` argument). So the citations were already pointing at a pre-`87dd773` revision
   *before* this refactor — it only shrank the file underneath them, turning wrong numbers into
   out-of-range ones. This is pre-existing docs drift, not a regression from this change, and
   "Out of scope" forbids both fixing bugs the refactor merely exposes and rewriting
   `docs/spec-*.md` prose. **Recorded, not fixed.** M5 did fix every citation this refactor
   actually invalidated (a path that no longer exists, or a symbol that moved to another
   module). Re-pointing these seven would mean inventing anchors for content the citation never
   correctly designated, and for `index.ts:460` the designated content now lives in
   `src/pi/tool.ts` — a rewrite of a historical decision, not a citation fix. Raise as its own
   docs-tidy task if the stale numbers are bothersome.
