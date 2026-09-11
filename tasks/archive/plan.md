# Plan: project-local settings file

Implements `docs/spec-project-config.md` (approved). Decisions 1–4 resolved in the spec's
"Resolved decisions": layering, skip-and-fall-back, child asymmetry accepted, commit the project
file.

## Objective

Teach config resolution a second scope. Today `src/config.ts:50-60` derives exactly one file from
`getAgentDir()`; after this, `<cwd>/.pi/tinysubagent.{jsonc,json}` layers over
`<agentDir>/tinysubagent.{jsonc,json}`, with `PI_TINYSUBAGENT_CONFIG` still short-circuiting
everything.

## Shape of the change

```
PI_TINYSUBAGENT_CONFIG ──► the only file read; layering stops
        │ absent
        ▼
configSources(cwd, agentDir)   project.jsonc? project.json? global.jsonc? global.json?
        │                      highest precedence first, only files that exist
        ▼
loadConfig(cwd, agentDir)      read lowest→highest, merge, collect warnings
                               → { enableProfiles, profiles, sources }
```

Two rules, independent: **scope beats filename** (project `.json` outranks global `.jsonc`), and
**within a directory** `.jsonc` outranks `.json`.

Merge: `profiles` by name (higher wins), `enableProfiles` from the highest file that specifies
the key, `sources: ConfigSource[]` records every file read (highest first).

Failure: any file that is unreadable, unparseable, or not an object is skipped with a warning and
resolution continues to the next scope.

## Implementation order

Dependency-ordered vertical slices. Each slice is test-first and leaves `npm run typecheck` and
`npm test` green — no slice is a half-applied state.

1. **Explicit arguments, behaviour unchanged.** `configPath`/`loadConfig` stop defaulting to
   `getAgentDir()`/`process.cwd()` and take `(cwd, agentDir)`. Call sites updated. Resolution is
   still global-only, so the existing 17 tests must pass with only mechanical edits. This isolates
   ~30 call-site edits from the new rules — the single biggest risk in the change.
2. **Project scope + precedence.** `ConfigScope`, `ConfigSource`, `configSources`, and the
   `source?: string` → `sources: ConfigSource[]` swap.
3. **Layering.** The merge loop and `enableProfiles` inheritance.
4. **Failure handling.** Skip-and-fall-back, with the originating file in warnings.
5. **Override + hermeticity.** `PI_TINYSUBAGENT_CONFIG` still wins outright; no ambient env or cwd
   reads below the entry point.
6. **Docs.** `docs/intent.md` + the `src/config.ts` header docstring.

Slices 2–5 are strictly sequential (same functions). **Slice 6 is independent of 2–5** — it
documents the approved spec, not the code — so it can be written in parallel. File ownership is
disjoint: the docs slice owns `docs/intent.md`, the code slice owns `src/config.ts` (including
its header docstring).

## Risks

| Risk | Mitigation |
|---|---|
| ~30 mechanical call-site edits burying the real diff | Slice 1 is behaviour-neutral and verified green on its own before any new rule lands |
| A "merge" test that puts both files in one temp dir proves nothing about layering | Merge/layering tests must use **two distinct** temp dirs; `path.dirname(file)` as both scopes is only valid for single-file tests |
| `configPath()` returning `null` is a semantic change (it used to return a path that may not exist) | Called out in slice 5; `test/config.test.ts:204` asserts the fall-through instead of a synthesised path |
| Same basename in both scopes (`tinysubagent.jsonc` × 2) | `sources` carries `scope`; file-level warnings already print full paths |
| `.gitignore`'s bare `.pi/` rule silently eating the file | Docs slice must ship the `.pi/*` + `!.pi/tinysubagent.jsonc` negation verbatim (spec, decision 4) |
| A repo file being able to break a working session | Skip-and-fall-back + full-path warnings; a malformed project file never disables profiles on its own |

## Out of scope

Child propagation (decision 3), hot reload, project-local settings for anything but profiles,
`settings.json` integration. See the spec.

## Verification checkpoints

After every slice: `npm run typecheck` and `npm test`. After slice 5: `npm test` with all 17
pre-existing config tests plus the 10 new ones green, and `npm run smoke` if a herdr session is
reachable (it is environment-dependent — a skip is not a failure). Final gate: `docs/intent.md`
matches the shipped precedence order exactly.
