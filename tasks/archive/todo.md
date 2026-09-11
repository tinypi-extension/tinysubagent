# Tasks: project-local settings file

From `tasks/plan.md`, spec `docs/spec-project-config.md`. Ordered by dependency — do not start a
task before its predecessor verifies. Checkpoint after each: `npm run typecheck` and `npm test`.

---

- [x] **Task 1 — Explicit arguments, behaviour unchanged**
  - Acceptance: `configPath(cwd, agentDir)` and `loadConfig(cwd, agentDir = getAgentDir())` take
    explicit arguments; `getAgentDir()`/`process.cwd()` appear only at call sites
    (`index.ts:196`, `test/extension.test.ts:171`, `scripts/smoke.ts:68`). Resolution remains
    global-only: same files, same warnings, same profiles as before. All 17 pre-existing
    `test/config.test.ts` tests pass with mechanical edits only.
  - Verify: `npm run typecheck && npm test`
  - Files: `src/config.ts`, `test/config.test.ts`, `test/extension.test.ts`, `scripts/smoke.ts`,
    `index.ts`

- [x] **Task 2 — Project scope and precedence**
  - Acceptance: `ConfigScope = "override" | "project" | "global"`, `ConfigSource { file, scope }`,
    `configSources(cwd, agentDir)` returns existing candidates highest-precedence-first. Project
    `.json` outranks global `.jsonc`; within a scope `.jsonc` outranks `.json`. `configPath`
    returns the winner or `null`. `TinysubagentConfig.source?: string` is replaced by
    `sources: ConfigSource[]`; `disabled()` takes `sources`.
  - Verify: `npm run typecheck && npm test` — new tests: project file alone is read (global
    absent); project `.json` beats global `.jsonc`; project `.jsonc` beats project `.json`;
    `sources` lists both files highest-first
  - Files: `src/config.ts`, `test/config.test.ts`, `index.ts`

- [x] **Task 3 — Layering merge**
  - Acceptance: files are read lowest→highest, `profiles` merge by name with the higher scope
    winning per name, `enableProfiles` is taken from the highest file that specifies the key
    (absent everywhere ⇒ `false`). A project file adding one profile inherits every global
    profile; redefining one replaces only that one.
  - Verify: `npm run typecheck && npm test` — new tests: project + global profiles merge and a
    name collision resolves to project; `enableProfiles` inherited from global while `profiles`
    come from project; a project file may switch `enableProfiles` off
  - Files: `src/config.ts`, `test/config.test.ts`

- [x] **Task 4 — Failure handling**
  - Acceptance: a file that cannot be read, cannot be parsed, or is not a JSON object is skipped
    with a warning naming that file, and resolution continues to the next scope. Malformed
    project + valid global ⇒ global applied, profiles **not** disabled, exactly one warning.
    Malformed project + no global ⇒ disabled. Malformed global ⇒ disabled. Profile-level warnings
    name the originating file. `dialect()` stays extension-keyed.
  - Verify: `npm run typecheck && npm test` — new tests: malformed project falls back to global;
    malformed project with no global disables; the warning names the offending file
  - Files: `src/config.ts`, `test/config.test.ts`

- [x] **Task 5 — Override and hermeticity**
  - Acceptance: `PI_TINYSUBAGENT_CONFIG` is the only file read and layering stops there (scope
    `"override"`); blank/whitespace means unset. No `process.cwd()` or `getAgentDir()` is read
    inside `configSources`/`configPath`/`loadConfig`. With no project file anywhere, resolution
    and warnings are byte-identical to pre-change behaviour. Merge tests use two distinct temp
    dirs so they cannot pass vacuously.
  - Verify: `npm run typecheck && npm test` — new tests: override beats a valid project file;
    no-project-file case matches the global-only baseline; `grep -n "process.cwd()\|getAgentDir()"
    src/config.ts` shows them only as a default parameter
  - Files: `src/config.ts`, `test/config.test.ts`

- [x] **Task 6 — Docs**
  - Acceptance: `src/config.ts` header docstring and `docs/intent.md` (`:53-54`, config section
    `:66-86`) state both locations, the full precedence chain, layering, `PI_TINYSUBAGENT_CONFIG`
    as the override, and the decision-4 team workflow: commit the project file, with the
    `.pi/*` + `!.pi/tinysubagent.jsonc` negation pair shown verbatim because a bare `.pi/` ignore
    rule silently swallows it. The accepted child asymmetry is noted. The documented order matches
    the shipped code exactly.
  - Verify: `npm run typecheck && npm test` (docs must not break the build); re-read the
    precedence paragraph against `configSources()` line by line
  - Files: `src/config.ts` (header only), `docs/intent.md`
