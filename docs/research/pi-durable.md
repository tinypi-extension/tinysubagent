# Pi Durable: what it does, and what can integrate with it

Researched 2026-10-29 against pi monorepo `v1.4.0` (`packages/durable`, package `@earendil-works/pi-durable@1.4.0`, marked **Experimental** in its own README) and the locally installed `@earendil-works/pi-coding-agent@1.4.0`.

Citation forms used below:

- `DUR-README#section` → https://github.com/earendil-works/pi/blob/main/packages/durable/README.md (section anchor)
- `DUR-SPEC:line` → https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md (normative spec, line number)
- `TINY:path:line` → this repo
- `PI-DOC:x` → `/Users/tinyphat/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/x`

---

## Summary

Here is the structural fact that decides everything else: **pi-durable is not a pi extension and pi exposes no hook that loads it.** It is a standalone harness/SDK you embed in your own process — storage + conversation + task machinery (`DUR-README#concepts`; the announcement's §"What is a harness?" says exactly this: "It does not replace the Pi coding agent. It is a framework for building any agentic application"). The installed `pi-coding-agent@1.4.0` does **not** depend on or mention it: `grep -ril durable docs/` hits only `extensions.md:344` ("Durable data excluded from model context" — that is `pi.appendEntry()`) and `rpc-commands.md:691` ("durable cursor" — that is the session entry id). So tinysubagent cannot "plug into" pi-durable the way it plugs into pi today.

What pi-durable *can* do is replace the plumbing tinysubagent currently hand-rolls: child lifecycle, spawn records, result delivery, and resume-after-restart. Its own README ships the exact pattern — a replay-safe subagent tool whose child conversation is owned by the tool task, recovered on rerun via `scanConversations({ ownerTaskId })` (`DUR-README#abort-and-subagents`, `DUR-SPEC:3975-4005`), plus example `22-subagent-background.ts` for persistent, restart-safe children with answers reported back (`DUR-README#examples`).

The realistic integration is therefore a **port, not an adapter**: reimplement tinysubagent's role/profile/env/report semantics as a pi-durable extension. Everything tinysubagent does with sidecar files, polling, and steer messages maps onto a durable primitive, and a few things (herdr panes, the `agy` harness, pane liveness) do not map at all.

---

## 1. What pi-durable does

### 1.1 Core primitives

| Primitive | What it is | Citation |
|---|---|---|
| **Harness** | One open storage + the machinery to run agents on it. All changes go through one line of atomic commits; nothing is shown before its commit is stored. | `DUR-README#concepts` |
| **Conversation** | A transcript, created via `root()` or `createConversation()`/`fork()`. Handle holds no state; compare by `id`. | `DUR-README#concepts`, `DUR-README#more-conversations-and-forks` |
| **Task** | Every unit the harness runs — model turn, tool call, compaction, your own kinds — is a task with a persisted state machine (`pending`/`running`/`waiting`/`completing`/terminal). | `DUR-README#task-graph`, `DUR-SPEC` |
| **Document** | Typed JSON application state (`defineDoc`) committed in the same atomic commit as the transcript that produced it, with `scope`, `history`, `fork` semantics. | `DUR-README#your-own-state` |
| **Extension** | Named bundle of `tools`, `sections`, `hooks`, `tasks`, docs, installed in a registry the host owns. | `DUR-README#extensions` |
| **Storage** | Memory / IndexedDB / SQLite (node, CF Durable Object) / JSONL backends behind a small `commit(writes, adopt)` interface. | `DUR-README#storage` |
| **Execution env** | `env: ({cwd}) => ExecutionEnv` builds the filesystem/shell per tool call, so each conversation can run somewhere else. | `DUR-README#environment` |

### 1.2 Checkpoints, persistence, resume

- Every step stores a checkpoint before it moves on. A new process opens the same storage, finds unfinished tasks, and continues each from its last checkpoint (`DUR-README#persist-and-resume`, announcement §"Survives crashes").
- `harness.resume()` "starts the task scheduler; submitting or waiting starts it too". Work interrupted by a crash or close **stays pending**, it is not lost (`DUR-README#persist-and-resume`).
- A model request the process died during counts as a failed attempt: partial answer kept as an aborted entry, retried under `settings.retry`, and after `settings.restartLimit` (default 5) the run ends `interrupted` instead of crash-looping forever (`DUR-README#failures-and-recovery`).
- Exactly-once input: `root.submit({..., requestId})` with a repeated `requestId` returns the existing submission; `harness.submission(id)` reacquires one by ID after a restart (`DUR-README#persist-and-resume`).
- Sleeping is stored: `runtime.sleepUntil(until, nextState)` ends a phase asleep, the task holds no invocation, and it resumes at the checkpoint when the clock reaches `until` — so long waits survive restarts (`DUR-README#sleeping-and-waking-up`).
- Read-only observers: `Harness.open(storage, {readOnly: true})` recovers nothing and every write/`resume()` rejects `ReadOnlySession` (`DUR-README#persist-and-resume`).

### 1.3 Storage backends and their constraints

`DUR-README#storage` table: `MemoryStorage` (root), `IndexedDbStorage.open(name)`, `openNodeSqliteStorage(file)` (WAL, `synchronous=NORMAL`; commits survive process crashes, newest may be lost on power loss), `openNodeJsonlStorage(dir, ctx)` (`{fsync:true}` optional; whole history in memory — SQLite recommended for long runs), `openDurableObjectSqliteStorage(ctx.storage)`.

Two constraints that matter for any tinysubagent integration:

1. **"One process owns a storage at a time; there is no cross-process locking."** (`DUR-README#storage`) — a durable storage is not a shared side-channel other processes may write.
2. SQLite tables can be namespaced with `{ prefix: "pi_" }`, and `StoreStorage`/Chord lets it share a database with host tables (`DUR-README#storage`, example `35-durable-on-the-store.ts`).

### 1.4 Always-on / multi-device operation

- **Always-on / serverless**: `onWake` tells the host when work can run (`active`, `at` = earliest sleep) so a Cloudflare Durable Object keeps an alarm armed and calls `resume()`; the default `setTimer` declines memory-only timers so a Worker can hibernate (`DUR-README#sleeping-and-waking-up`).
- **Multi-client**: "Everything a UI needs is committed state." `conversation.watch()` streams the structural view + Chord ops; `viewState()`/`subscribe()` give the current view then changes; `ConversationTranscript` handles reconnect gaps and "load earlier"; a client that joins late gets the current view and nothing is replayed (`DUR-README#watching-a-conversation`, announcement §"Multiplayer").
- **Steering**: `submit({whenBusy:"steer"|"followUp"})`, plus `submit(tx, draft)` inside a host commit (`DUR-README#busy-conversations`, example `34-submit-in-commit.ts`).
- **Forks**: a conversation forks at any entry and sees the parent's history up to that point without copying it (`DUR-README#more-conversations-and-forks`).

### 1.5 Malleable agent definitions

- A conversation stores *what it runs with* as **names** in its `pi.agent` document — model, thinking level, extensions, tools, `modelTools`, `instructions`, `cwd`, `maxTurns` — resolved against the registry at each use (`DUR-README#concepts`, `DUR-README#per-conversation-agent`).
- `registry.install(ext)` with an already-installed name **replaces it in one step**; a running tool call finishes on the code it started with, the next call uses the new code; after a restart install the same extensions again and pending tasks resume (`DUR-README#reload`).
- Extensions/tools are stored by name, so a stored name outlives its code (`DUR-README#per-conversation-agent`).

### 1.6 What pi-durable does **not** have

- **No built-in subagents.** "Pi Durable has no built-in subagents, but they take a few lines of code to build" (announcement §"Survives crashes"); the README instead documents the pattern (`DUR-README#abort-and-subagents`). This is the single largest overlap with tinysubagent.
- **No panes, no TUI.** UI is the host's problem; `watch()` yields state and ops (`DUR-README#watching-a-conversation`). There is nothing resembling herdr pane management.
- **No pi-CLI extension surface.** pi-durable extensions are `defineExtension` objects installed in a durable `createRegistry()`; they are not pi `ExtensionAPI` extensions and are not loaded by `pi` (`DUR-README#extensions`; `PI-DOC:extensions.md` describes a different API — `pi.registerTool`, `pi.on("session_start")`, `pi.appendEntry`).
- **The blog's coding-agent-on-durable entrypoint is gone from main.** The announcement says to run `node packages/coding-agent/src/experimental/durable/main.ts`; `packages/coding-agent/src/experimental/` on `main` now contains only `source-resolver.ts` (checked via GitHub contents API). **UNVERIFIED** whether it moved or was removed; treat "pi the coding agent runs on durable" as not-true for 1.4.0.

---

## 2. API surface

Root exports (from `packages/durable/src/index.ts`; package exports map `{".": ..., "./env", "./env/node", "./codemode", "./tool-search", "./tools", "./images", "./images/node", "./images/cloudflare", "./storage/memory", "./storage/indexeddb", "./storage/jsonl", "./storage/jsonl/node", "./storage/store", "./storage/sqlite", "./storage/sqlite/cloudflare", "./storage/sqlite/node", "./testing"}`):

**Runtime**
- `Harness.open(storage, { models, registry, env?, settings?, onWake?, conversationCreated? }, context)` → `Harness` (`DUR-README#quick-start`, `#settings`, `#environment`).
- `harness.root(context, {agent?})`, `harness.resume()`, `harness.wake()`, `harness.usage(ctx)`, `harness.snapshot(Doc, id, ctx)`, `harness.watchDoc(...)`, `harness.watchTaskGraph(ctx)`, `harness.inspect()`, `harness.observeConversation/TaskGraph/Doc(...)`, `harness.submission(id)`, `harness.closed` / `close()` (`DUR-README#persist-and-resume`, `#your-own-state`, `#task-graph`, `#watching-a-conversation`, `#errors`).
- `Conversation`: `submit(draft, ctx)`, `submit(tx, draft)`, `abort`, `commit(fn, ctx, {persistence})`, `fork(entry, ownership, ctx)`, `watch()`, `viewState()`, `configure(change, ctx)`, `agent()`, `entries(range, …)`, `context()` (`DUR-README` §persist/busy/per-conversation-agent/watching).
- `Submission.wait(ctx)` resolves at the settled outcome (`done` + `answer`, `unanswered`, etc.) — "the answer is committed and the run's inputs settle `done` before the hooks are asked" (`DUR-README#work-at-the-end-of-a-run`).

**Authoring**
- `createRegistry()`, `defineExtension({name, tools, sections, hooks, tasks})`, `defineTool({name, description, parameters, replay: "safe"|"unsafe", callers, deferred, execute(args, api, context)})`, `defineTask<I,S,O>({name, version, initial, phases, abort})`, `defineDoc<T>({kind, version, scope, history, fork, initial, checkpointWhen})`, `section(name, fn, {tag})`, `hook(TaskKind, {beforeTool, onYield, afterResponse, afterTools, afterRun, ...})`, `wrapTool()` (`DUR-README#extensions`, `#hooks`, `#tools`, `#work-at-the-end-of-a-run`, `#your-own-state`).
- Tool `api`: `api.commit`, `api.taskId`, `api.conversationId`, `api.conversation(id, ctx)`, `api.details(value, ctx)`, `api.snapshot`, `api.abort`, `executeTool()` for nested calls (`DUR-README#calling-tools-from-tools`, `#abort-and-subagents`, `DUR-SPEC:3975-4005`).
- Task `runtime`: `runtime.commit(fn|state, ctx)`, `runtime.sleepUntil(at, nextState, ctx)`, `runtime.outcomes(ids, ctx)`, `runtime.env()` (`DUR-README#child-tasks`, `#sleeping-and-waking-up`).
- Types: `types.ts` is 61 KB and the root re-exports ~100 names (`Storage`, `Task`, `TaskState`, `SubmissionRecord`, `TaskOwnership`, `ConversationRecord`, …) per `src/index.ts`.

**Testing**: `@earendil-works/pi-durable/testing` — `registerStorageConformance`, `registerEnvConformance` (`DUR-README#storage`).

**Documented vs inferred.** Everything above except the two items below is documented in `DUR-README` or `DUR-SPEC`.
- *Inferred (source-read, low risk):* the module list under `src/` — `harness/`, `session/`, `storage/`, `tools/`, `codemode/`, `tool-search/`, `env/`, `testing/` — reflects the exports map rather than a documented layout.
- *Inferred:* that `Harness` can be opened in-process inside a pi CLI extension. Nothing forbids it (it is plain ESM with no peer dependency on `pi-coding-agent`; deps are `chord`, `pi-ai`, `pi-codemode`, `pi-telemetry`, `photon`, `diff`, `typebox`), but no documented integration exists and running a second scheduler inside pi's process is untested here. **UNVERIFIED.**

---

## 3. What tinysubagent already has

| Capability | Where |
|---|---|
| `subagent` tool, registered only inside herdr | `TINY:index.ts:55` (`if (!isInsideHerdr()) return;`), `index.ts:91`; `TINY:src/herdr/cli.ts:50` |
| Fire-and-forget spawn → immediate ack | `TINY:index.ts:1-8`; `TINY:src/pi/tool.ts:164-200` |
| Child spawned as a **separate OS process** in a herdr pane | `TINY:src/children/spawn.ts:159` (`herdrPaneOpen`), `src/children/launch-script.ts` |
| Detached watcher, poll every 1s, pane liveness every 5 polls | `TINY:src/children/watcher.ts:32`, `:50`, `:278` |
| Completion sidecars beside the child session: `<session>.done`, `<session>.exitcode` | `TINY:src/children/launch-paths.ts:103-104`; env passed as `PI_TINYSUBAGENT_REPORT` / `PI_TINYSUBAGENT_SESSION` (`src/children/launch-script.ts:90-91`) |
| Child `subagent_report` tool, atomic temp+rename write, then `ctx.shutdown()` | `TINY:src/children/child.ts:120-176`; `src/children/report.ts:62`; name in `src/types.ts:45` |
| Result scrape fallback from the child's JSONL session | `TINY:src/children/session.ts` (`readFinalMessage`, `findFailureNote`) |
| Wake the orchestrator with a **steer** message | `TINY:src/pi/watch-batch.ts:27-40` (`deliverAs: "steer"`, `triggerTurn: true`) |
| Roles as markdown + frontmatter `tools` allowlist | `TINY:src/config/agents.ts`; `src/children/spawn.ts:88-110` |
| Profiles (`model`, `thinking`, `harness: pi|agy`) | `TINY:src/types.ts:66`; `src/config/profiles.ts:84` |
| Per-child static `env` from config | `TINY:src/children/spawn.ts:129` (`env: context.config.env`); merged in `src/config/config.ts:350-380` |
| Config: project/global `.pi/tinysubagent.jsonc` | `TINY:src/config/config.ts:101`, `:257-290` |
| Shutdown aborts all watchers | `TINY:src/pi/lifecycle.ts:35-42` |

**The gap.** There is no persisted spawn record. `RunningSubagent` (`TINY:src/children/watcher.ts:50-62`) exists only in the `runnings` array of one `execute()` call (`TINY:src/pi/tool.ts:164`) and in the in-memory `watchers` set owned by `index.ts:64`. If the orchestrator pi dies, or is resumed from its session file, the sidecars and child sessions are still on disk but **nothing will ever read them**: the batch, its steer message, and the pane→result association are gone. `pi --continue` cannot recover a pending subagent.

---

## 4. Integration options, best fit first

### Option A — Port tinysubagent's semantics to a pi-durable extension (**recommended**)

Build the `subagent` tool as a durable extension instead of a pi extension. This is the pattern the package documents for exactly this use case.

| tinysubagent today | pi-durable equivalent | Durable guarantees you gain |
|---|---|---|
| `spawnOne` writes script + task md, opens pane (`spawn.ts:159`) | `api.commit(tx => tx.createConversation({ownership:{kind:"task",taskId:api.taskId}}))` (`DUR-README#abort-and-subagents`) | Spawn record is a committed conversation row; a replay-safe rerun finds it with `scanConversations({ownerTaskId})` (`DUR-SPEC:3975-3980`) |
| In-memory `runnings` (`tool.ts:164`) | the owner edge + `api.details({conversationId})` | Survives orchestrator restart; a UI can attach to the child |
| Watcher poll + `.done` sidecar (`watcher.ts:32`) | `handle.submit({type:"input",requestId:`subagent:${api.taskId}`}).wait(ctx)` | Result arrives at settlement; no polling, no token-in-file race |
| `subagent_report` + atomic rename (`report.ts:62`) | the answer entry itself (and/or a child `defineDoc`/`api.commit`) | Report is committed before it is visible (`DUR-README#concepts`) |
| Steer wake (`watch-batch.ts:30`) | the tool returns the answer, or a background reporter task posts it as a follow-up input (example `22`) | Restart-safe delivery; `requestId` prevents double-delivery |
| Role `tools` allowlist (`spawn.ts:66-90`) | `configure(tx, child, {tools:[...], modelTools:[...]})` (`DUR-README#per-conversation-agent`) | Stored by name, resolved each use |
| Role body = child system prompt | `sections: [section("role", () => body, {tag:false})]` or `instructions` | Committed as part of `pi.agent` |
| Profile `model`/`thinking` (`profiles.ts:84`) | `configure({model, thinkingLevel})` (`DUR-README#per-conversation-agent` L382-398) | — |
| Per-child `env` (`spawn.ts:129`) | `env: ({cwd, conversationId}) => new NodeExecutionEnv({...process.env-overrides})` (`DUR-README#environment`) | — |
| Project/global jsonc config | host code, unchanged (read it and pass to `configure`) | — |
| `maxTurns`-ish batch limits | `configure({maxTurns})` + `settings.afterFailedRun` | Per-run turn budget, survives restarts |

What changes: the tool becomes a `defineTool({replay:"safe"})`; the child no longer needs `subagent_report` (its answer is the answer) — though keeping an explicit hand-back is expressible as a tool that commits a child doc; delivery becomes a return value or a background reporter task; and the whole extension needs a host process that owns the storage and calls `harness.resume()` (`DUR-README#persist-and-resume`).

What is **lost or impossible** in Option A:
- **herdr panes.** pi-durable has no concept of panes or layout; nothing in `DUR-README` or `DUR-SPEC` covers anything like `LiveSubPanes` (`TINY:src/herdr/layout.ts`). A durable child is a conversation inside the host process, not a visible terminal. If interactive human steering of a *visible* child is the product, this port removes it (the durable substitute is multi-client steering, `DUR-README#busy-conversations`).
- **The `agy` harness.** `TINY:src/children/harness/agy.ts` shells out to another CLI; durable runs pi-ai models in-process. No equivalent.
- **Pane-liveness as a cancellation signal** (`watcher.ts` "cancelled" outcome). Abort semantics exist (`root.abort`, ownership cascade) but there is no "the user closed the window" event.
- **Silent-errors semantics.** tinysubagent deliberately writes nothing on a failed/unstartable run and holds the pane (`docs/issues/silent-errors/spec.md`, `child.ts:1-80`). Durable instead commits a `runFailure`, counts the interruption, and can end the run after `restartLimit` — a different, agitated-instead-of-silent policy. This is a design conflict to settle, not a mechanical port.

### Option B — Use pi-durable purely as a durable store for spawn records, keeping herdr spawns (**weak fit, partly impossible**)

Idea: keep tinysubagent as-is, but write each spawn record / sidecar state into a durable document so a restarted orchestrator can find pending children.

- What durable gives: `defineDoc` with atomic commits and `harness.snapshot`/`watchDoc` (`DUR-README#your-own-state`) — a real store, not a file.
- What it would need: a long-lived process holding the storage open, since "one process owns a storage at a time; there is no cross-process locking" (`DUR-README#storage`). The herdr-spawned child **cannot** safely write that document; and the orchestrator pi, being a pi *extension* host, has no durable `Harness` to commit into unless you open one inside pi's process (unverified, Option A's host anyway).
- Verdict: if you are going to open a `Harness` in-process, you have already paid Option A's cost, and the file sidecars are simpler. **Not recommended.** Using pi-durable as a generic KV store is not a supported use: no KV API is documented, and opening a Harness loads TypeBox (~23 MB peak RSS unbundled / ~4 MB tree-shaken, `DUR-README#storage`).

### Option C — Borrow the patterns, not the dependency

Keep `TINY:*` on pi and adopt the durable idioms with pi's own persistence:
- exactly-once delivery via a stable `requestId`-style key → a batch id persisted with `pi.appendEntry()` (`PI-DOC:extensions.md:180,344`, "Durable data excluded from model context");
- a spawn record reconstructed from `ctx.sessionManager.getBranch()` at `session_start` (`PI-DOC:extensions.md:348`);
- replay-safe spawn: on restart, re-read sidecars for session ids recorded in the session and re-arm the watcher.
- What durable gives that this does not: crash-consistency, retry/`restartLimit`, cross-device clients, and the task scheduler. What you keep: herdr panes, `agy`, and the existing silent-error policy.
- Cost: you reimplement a small scheduler. `PI-DOC:extensions.md:346` explicitly says data outside one session belongs in "External storage".

### Option D — hybrid: herdr pane + durable child conversation

Not supported by anything documented. A durable conversation runs inside the harness process; a herdr pane runs a separate `pi` process. There is no documented way to have the pane *be* the durable child, and the storage-ownership rule (`DUR-README#storage`) rules out two processes sharing it. **Do not plan around this.**

---

## 5. Open questions / unverified

1. **Can a `Harness` be opened inside a pi coding-agent extension's process?** No documented support; no `pi-coding-agent` peer dep in `pi-durable`. Would need a spike (two schedulers, two `setTimer` owners, session vs storage ownership). **UNVERIFIED.**
2. **Where did `packages/coding-agent/src/experimental/durable/main.ts` go?** Referenced by the announcement; absent from `main` at v1.4.0. **UNVERIFIED** whether it moved, was renamed, or was dropped.
3. **API stability.** The README's first line is "**Experimental.** The API changes without notice between releases." Any port should pin an exact version (deps are all `1.4.0`, including `@earendil-works/chord`).
4. **Do tinysubagent's `subagent_report` / silent-hold semantics survive translation?** Durable has no "write nothing and wait for a human" state; the closest is an unresolved submission plus a client that steers. Needs a decision record before any port.
5. **Nested delegation.** tinysubagent refuses it (`TINY:src/children/spawn.ts:81-90`); durable supports nesting natively via owned conversations and `executeTool()`. A port could lift that restriction — a product decision, not a technical one.
6. **Does the Chord dependency make embedding awkward?** `pi-durable` hard-depends on `@earendil-works/chord@1.4.0` and re-exports `WatchHandle`; whether a pi extension could host Chord's scheduler without interfering with pi's own promise/`setTimeout` usage is **UNVERIFIED**.

---

## Sources

- `@earendil-works/pi-durable` README (v1.4.0) — https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- `packages/durable/docs/spec.md` (normative, 6,406 lines) — https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md
- `packages/durable/src/index.ts` and `package.json` — https://github.com/earendil-works/pi/tree/main/packages/durable
- "Pi Durable" announcement, Earendil Engineering, 2026-10-01 — https://earendil.com/posts/pi-durable
- Local pi API contract (`@earendil-works/pi-coding-agent@1.4.0`): `docs/extensions.md`, `docs/sdk.md`, `docs/packages.md`, `docs/sessions.md`, `docs/session-format.md` — `/Users/tinyphat/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/`
- tinysubagent source — this repo (`index.ts`, `src/children/*`, `src/pi/*`, `src/config/*`), `docs/issues/silent-errors/spec.md`
