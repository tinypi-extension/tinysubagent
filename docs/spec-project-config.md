# Spec: project-local settings file

**Status: approved.** All four decisions resolved (see "Resolved decisions"); implementing.

## Assumptions I'm making

1. **Location is `<cwd>/.pi/tinysubagent.jsonc`** (and `.json`), i.e. the project root's `.pi/`
   directory — not `<cwd>/.pi/agent/`. You named this path explicitly, and it matches the
   existing `projectAgentsDir()` convention (`src/config/agents.ts:32` → `<cwd>/.pi/agents`) plus the
   `.jsonc`-over-`.json` rule already stated in `docs/intent.md:110`.
2. **Scope means the pi process's `cwd`**, the project the extension is loaded for. `cwd` is
   passed in explicitly rather than read from `process.cwd()` inside the resolver (see
   "Deliberate non-behaviour" below).
3. **The global file keeps its meaning** — `~/.pi/agent/tinysubagent.jsonc` stays exactly where
   it is, and stays valid on its own. Nothing about the global path changes.
4. **This is about profile config only.** Agents/markdown roles already have their own
   project-local mechanism (`<cwd>/.pi/agents`, `src/config/agents.ts:127`) and are untouched.
5. **The project file is trustworthy-ish but not authoritative-over-safety** — a malformed
   project file must not be able to disable delegation that was working (see "Failure
   behaviour").
6. **`cwd` is resolved once, at extension registration** (`index.ts:196`), not per tool call.
   That matches how agents are advertised (`index.ts:200`, `process.cwd()`).
7. **The precedent for two-scope discovery already exists in this repo** — `discoverAgents`
   merges `~/.pi/agent/agents/*.md` with `<project>/.pi/agents/*.md`, project winning by name
   (`src/config/agents.ts:127-145`, documented at `docs/intent.md:21`). Profiles get the same shape.

→ Correct any of these now, or I'll build on them.

## Current behaviour (verified, not assumed)

- The only derivation point is `src/config/config.ts:50-60`; `getAgentDir()` (SDK `dist/config.js:421`)
  is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. No cwd input exists anywhere in the resolver.
- Sole production caller: `index.ts:196 const { config, warnings: configWarnings } = loadConfig();`
  — no-argument. Consumed at `:197` (tool schema), `:276` (tool description), `:303`/`:321`
  (profile validation, `SpawnContext.config`), then only `src/children/spawn.ts:40 resolveProfile`.
- `test/pi/extension.test.ts:171` and `scripts/smoke.ts:68` also call `loadConfig()` no-argument,
  against the real agent dir. `scripts/smoke-tool.ts:86` relies on the `PI_TINYSUBAGENT_CONFIG`
  override.
- The config does **not** reach children: `PI_TINYSUBAGENT_CONFIG` is never written into the
  launch script, and `src/children/launch-script.ts:68-79` exports only `PI_CODING_AGENT_DIR` (when
  `<cwd>/.pi/agent` exists) plus the `PI_TINYSUBAGENT_*` identity vars.
- Prose to update: `src/config/config.ts:1-8` (header docstring) and `docs/intent.md:53-54`, `:66-74`, `:103-114`.

## Objective

Today `tinysubagent` reads exactly one settings file, from the agent dir
(`~/.pi/agent/…`, `src/config/config.ts:50`). That makes profiles a per-user, per-machine concern: a
repository cannot ship the model/thinking profiles its own work depends on, and every clone on
every machine has to be hand-configured.

Add a project-local settings file so a repo can declare profiles that apply when the extension
runs in that project. The user is the person running pi inside a checked-out project. Success is
a repo committing a `.pi/tinysubagent.jsonc` that adds or overrides profiles without every
contributor having to copy it into their home directory — and without a contributor's existing
global profiles being silently replaced by a repo file.

## Scope check

One capability: config resolution gains project scope. Not decomposed — acceptance criteria all
cluster around a single precedence rule and its failure mode, and no part of it ships or is
verified independently. No capability map.

## Resolution rule (authoritative)

Highest precedence first. The first entry that exists wins its *scope*, and scopes layer
(`enableProfiles: true` may live in one file while a profile it needs lives in another):

| # | File | Scope |
|---|---|---|
| 1 | `$PI_TINYSUBAGENT_CONFIG` | override — the only file read, layering stops here |
| 2 | `<cwd>/.pi/tinysubagent.jsonc` | project |
| 3 | `<cwd>/.pi/tinysubagent.json` | project |
| 4 | `<agentDir>/tinysubagent.jsonc` | global |
| 5 | `<agentDir>/tinysubagent.json` | global |

Two rules, and they are independent of each other:

- **Scope beats filename.** A project `.json` outranks a global `.jsonc`. The existing
  `.jsonc`-over-`.json` rule is a *within-directory* tiebreak ("which file is this directory's
  config"), not a global one.
- **Within a directory**, `.jsonc` wins and the sibling `.json` is ignored silently — unchanged
  behaviour, now applied twice.

## Merge semantics

The files layer; they do not replace each other.

- `enableProfiles` — value from the highest-precedence file that **specifies the key**. Absent
  everywhere ⇒ `false`. A project file may flip a globally-enabled feature off and vice versa.
- `profiles` — merged **by name**, higher precedence wins per name. A project file adding one
  profile inherits every global profile; redefining one replaces just that one. This is what
  lets a committed repo file stay small and not have to restate a contributor's personal
  profiles.
- `sources` (see below) reports every file that contributed.

Rationale for layering over whole-file replacement: a repo-committed file cannot know a
contributor's global profile names, so replacement would mean any project file blanks out the
user's personal profiles — the entanglement `docs/intent.md` explicitly designs against.

**Decided: layering** (see "Resolved decisions") rather than "project file, if present,
replaces the global config entirely". Had replacement been chosen, the merge bullet points above
would collapse and §"Failure behaviour" would simplify, but a project file would have to
duplicate any global profile it wanted to keep.

## `source` field change

`TinysubagentConfig.source?: string` (`src/config/config.ts:20`) is a single basename, set at
`src/config/config.ts:116`, consumed by the "enableProfiles is true but no usable profiles" warning
(`src/config/config.ts:176-178`), and asserted in `test/config/config.test.ts:175`.

With two scopes one basename is no longer truthful — `tinysubagent.jsonc` is ambiguous between
project and global. Replace it:

```ts
/** Every file that contributed, highest precedence first. Empty when none. */
sources: ConfigSource[];
```

`source` is removed rather than kept alongside; `sources` carries `{ file, scope }` so the
ambiguity cannot come back. Note the existing split, which is deliberate and preserved:
**file-level warnings already use the full path** (`src/config/config.ts:131,140,150,176`), while
`source` was basename-only so a notify stays short (`src/config/config.ts:113-115`). Rendering
`sources` reuses `path.basename`, and the "no usable profiles" warning now names the
highest-precedence contributing file.

## Failure behaviour

A file that cannot be read, cannot be parsed, or is not a JSON object is **skipped with a
warning, and resolution continues to the next scope**. A malformed project file therefore falls
back to the global config; the warning names the offending file.

- Malformed project + valid global ⇒ global config applied, one warning, profiles **not**
  disabled.
- Malformed project + no global ⇒ profiles disabled, one warning. Same as today.
- Malformed global ⇒ profiles disabled, one warning. Same as today.

This extends the existing principle stated at `src/config/config.ts:44` ("a typo in this file never
silently disables delegation"). A repo file is authored by a third party from the user's point
of view, so it should be *less* able to break a working session, not equally able.

Profile-level warnings (`normalizeProfile`, `src/config/config.ts:76`) gain the originating file so a
bad profile in a repo file is attributable. Note `dialect()` (`src/config/config.ts:67`) already keys
off the extension only, so it stays correct for both scopes.

**Decided: skip-and-fall-back**, not fail-closed.

## Deliberate non-behaviour

`configPath()` currently defaults its argument to `getAgentDir()` and is called with no
arguments in production (`index.ts:196`) and in tests (`test/config/config.test.ts:191,204`). Adding
project scope means a no-argument call becomes environment-dependent: the moment this repo
gains its own `.pi/tinysubagent.jsonc` — the exact thing this feature invites — tests calling
`configPath(dir)` would start reading the repo's file and fail.

So the resolver takes `cwd` **explicitly** and never defaults it to `process.cwd()`:

```ts
export type ConfigScope = "override" | "project" | "global";

export interface ConfigSource {
	file: string;          // absolute path
	scope: ConfigScope;
}

/** Existing candidates, highest precedence first. Empty when none exist. */
export function configSources(cwd: string, agentDir: string): ConfigSource[];

export function configPath(cwd: string, agentDir: string): string | null;
export function loadConfig(cwd: string, agentDir?: string): LoadedConfig;
```

`process.cwd()` / `getAgentDir()` appear only at the call site (`index.ts:196`), which is what
keeps the tests hermetic. `PI_TINYSUBAGENT_CONFIG` still short-circuits everything, so the
env-override test (`test/config/config.test.ts:184`) keeps working and stays the documented escape
hatch.

This changes `configPath`/`loadConfig`'s signatures. Both are internal (`0.1.0`, `peerDependencies`
only, no public API promise) and the ~30 call sites are all in `test/config/config.test.ts`,
`test/pi/extension.test.ts:171`, and `scripts/smoke.ts:68` — mechanical updates.

## Files

| File | Change |
|---|---|
| `src/config/config.ts` | header docstring (`:1-8`); `configSources`/`configPath`/`loadConfig` resolution; layering merge; scoped warnings; `sources` field |
| `index.ts` | pass `process.cwd()` + `getAgentDir()` at the one production call site (`:196`) |
| `test/config/config.test.ts` | update the signature/`sources` assertions (`:154,157,165,175,191,200,204`); add project-scope cases |
| `test/pi/extension.test.ts` | `loadConfig()` call site (`:171`) |
| `scripts/smoke.ts` | `loadConfig()` call site (`:68`) |
| `src/config/profiles.ts` | removal of `source` reaches here: the disabled-profile refusal message (`:84`) reads `config.sources[0]` and renders `path.basename` |
| `test/config/profiles.test.ts` | `TinysubagentConfig` literals need `sources`; attribution test sets it |
| `test/children/spawn.test.ts` | `TinysubagentConfig` literal needs `sources` |
| `docs/intent.md` | both locations + precedence chain in `:53-54` and the config section (`:66-86`); the `.pi/*` + `!.pi/tinysubagent.jsonc` negation recipe |

The last three rows were missing from this table when the spec was approved — the `source` field turned
out to have a second consumer (`src/config/profiles.ts:84`) and two test files construct the interface
literally. Harmless, but the Files list was incomplete; see "Implementation notes".

No new dependencies. `CONFIG_DIR_NAME` comes from the pi SDK (`src/config/agents.ts` already imports
it) rather than hardcoding `.pi`. `scripts/smoke-tool.ts:86` needs no change — it exercises the
override, which keeps winning.

## Commands

```
Test:      npm test            # node --test test/*.test.ts
Typecheck: npm run typecheck   # tsc --noEmit
Smoke:     npm run smoke
```

`npm test` and `npm run typecheck` must both be clean before this is done.

## Code style

Pure resolution functions, explicit arguments, no ambient environment reads below the entry
point — matching the existing `config.ts`:

```ts
export function configSources(cwd: string, agentDir: string): ConfigSource[] {
	// `.jsonc` is preferred over `.json` *within* a scope, and a project scope outranks a
	// global one regardless of extension — the filename picks the dialect, not the precedence.
	return [
		preferred(path.join(cwd, CONFIG_DIR_NAME), "project"),
		preferred(agentDir, "global"),
	].flatMap((candidate) => candidate);
}
```

Comments explain *why* a rule exists, not what the line does. Warnings stay one sentence,
prefixed `tinysubagent: `, and name the file involved.

## Testing strategy

`node:test` + `node:assert/strict`, temp dirs via `mkdtempSync` — extending the existing harness
in `test/config/config.test.ts` (`writeNamed` `:11-16`, `configDir` `:27-28`). Both `cwd` and `agentDir`
become real temp dirs, so no test touches the developer's `~/.pi`; today `:204` calls the real
`getAgentDir()`, and that indirection is what the explicit-argument signature removes.

`test/config/config.test.ts` isolates `PI_TINYSUBAGENT_CONFIG` only inside the one test at `:184-208`
with a manual save/restore; the new project-scope tests need the same guard, so extract a
`withEnv` helper along the lines of the one already in `test/pi/extension.test.ts:55-71`. Never set
`PI_CODING_AGENT_DIR` globally — pass `agentDir` as an argument instead.

New cases, one per rule:

1. Project file alone is read; global absent.
2. Project profile + global profile merge; a name collision resolves to the project's.
3. `enableProfiles` is inherited from global while `profiles` comes from project.
4. Project `.json` outranks global `.jsonc` (scope beats filename).
5. Project `.jsonc` outranks project `.json` (existing rule, project scope).
6. Malformed project + valid global ⇒ global applied, warning, profiles on.
7. Malformed project + no global ⇒ disabled.
8. `PI_TINYSUBAGENT_CONFIG` outranks a valid project file.
9. `sources` lists both files, highest precedence first.
10. No project file anywhere ⇒ identical outcome to today's global-only behaviour.

Existing tests 1–17 in that file must pass unchanged except for the signature/`sources` edits.

## Boundaries

- **Always:** run `npm test` and `npm run typecheck`; keep warnings one sentence and
  file-attributed; keep resolution pure and argument-driven; update `docs/intent.md` in the same
  change.
- **Ask first:** changing the project file's location or name; adding a dependency; making the
  project file fail-closed; re-resolving config per tool call or adding hot reload.
- **Never:** change or move the global `~/.pi/agent` path; touch the agent-discovery mechanism
  (`src/config/agents.ts`); let a repo-committed file disable delegation; write to any file the user
  owns as a side effect of loading.

## Out of scope

- Hot config reload / per-call re-resolution (`docs/intent.md:64` already excludes it).
- Passing the resolved config down to child panes via env. A child resolves its own scopes from
  its own cwd, which is the same project — but see "Resolved decisions" §3 for why that is
  *nearly*, not exactly, the parent's answer.
- Project-local settings for anything other than profiles.
- Any `.pi/settings.json` integration — `src/config/config.ts:1` is explicit that this config
  deliberately does not entangle with pi's settings file.

## Success criteria

Specific and testable. Criteria 1–6 correspond to the new tests above by number.

1. A `.pi/tinysubagent.jsonc` in the project adds a profile and a global profile set still works.
2. Profile name collisions resolve to the project file.
3. Scope outranks filename in both directions, and `.jsonc` outranks `.json` within a scope.
4. `PI_TINYSUBAGENT_CONFIG` still wins over every file.
5. A malformed project file warns, names the file, and still yields the global config.
6. With no project file, resolution and warnings are identical to pre-change behaviour.
7. `npm test` passes, including all 17 pre-existing `config` tests.
8. `npm run typecheck` reports no errors.
9. `docs/intent.md` documents both locations, the full precedence chain, and the
   `.pi/*` + `!.pi/tinysubagent.jsonc` negation recipe.
10. Nothing in the change reads `process.cwd()` or `getAgentDir()` below the extension entry
    point.
11. A project file that defines profiles while `enableProfiles` is off everywhere stays
    **silent** — no new warning.

## Implementation notes

Shipped as designed. Deviations from this spec, all recorded rather than silent:

1. **`sources` had more consumers than this spec listed.** `src/config/profiles.ts:84` also read
   `config.source` (the disabled-profile refusal message), and `test/config/profiles.test.ts` /
   `test/children/spawn.test.ts` construct `TinysubagentConfig` literals. Fixed mechanically —
   `sources[0]` basename, and `sources: []` in the literals. No rule changed.
2. **No `disabled()` constructor.** The pre-existing helper was dropped rather than reshaped: the
   merge loop's `sources: []` + `enableProfiles: false` already produces the disabled state.
3. **`configPath` honours the override.** This spec said it returns "the winner's file, or
   `null`" without deciding whether the override counts. The override is returned verbatim, even
   if it names a missing file, preserving the escape hatch and the "blank means unset" test.
   `configSources` deliberately excludes the override — it reports scope files only.
4. **File-level warnings no longer say "profiles are disabled".** With fallback, a skipped file
   cannot make that claim; they now say "ignoring it" and name the file. Verified by probe.

Verified independently of the implementer: `npm run typecheck` clean; `npm test` 168/168 (17
pre-existing config tests + 16 new, 152-test baseline); never a spec-pre-existing test deleted or
weakened. Two out-of-process probes against real temp directories confirmed the layered merge
(project overrides `shared`, `onlyGlobal` survives, `enableProfiles` inherited from global,
`sources` highest-first) and both fallback paths. `npm run smoke` also passes end to end in a
real herdr session — a real child spawned with a real global profile through the changed
`loadConfig(process.cwd(), getAgentDir())` call site.

One process-hygiene issue: a subagent added `tasks` to `.gitignore` without reporting it. That
would have dropped the tracked plan/todo files on commit. Reverted; `.gitignore` now differs from
HEAD only by the pre-existing `.recon`/`.codegraph` lines.

## Resolved decisions

1. **Layering** — confirmed over whole-file replacement.
2. **Skip-and-fall-back** — confirmed over fail-closed. A malformed project file warns, names
   itself, and resolution continues to global.
3. **Child asymmetry accepted** — nothing is forwarded to child panes. A nested delegation in
   the `<cwd>/.pi/agent` scenario resolves against that directory as its global scope and may see
   a different merged profile set than its parent. Documented, not fixed.
4. **Repos should commit `.pi/tinysubagent.jsonc`** — so the docs carry a team-workflow note.

### Finding folded into decision 4

`git check-ignore -v .pi/tinysubagent.jsonc` in *this* repo returns `.gitignore:4:.pi/` — a bare
`.pi/` ignore rule (very common, since `.pi/` usually holds per-machine agent state) silently
swallows the config file. The documented recipe must therefore be the negation pair:

```gitignore
.pi/*
!.pi/tinysubagent.jsonc
```

`.pi/*` rather than `.pi/` is what makes the negation possible — git cannot re-include a file
whose parent directory is excluded. Without this, "commit your project config" fails silently in
exactly the repos most likely to try it. This is a docs requirement, not a code one: the
`docs/intent.md` config section must show the pattern verbatim.

Superseded open questions (all now answered): layering vs replacement, malformed-project
handling, child propagation, commit convention.

