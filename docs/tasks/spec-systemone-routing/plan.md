# Plan: SystemOne profile routing (`systemOneAPIKey` + `systemOneBaseUrl`)

Implements `docs/specs/spec-systemone-routing.md` (460 lines, approved). Repo `tinysubagent`
@ `415096a`.

**Baseline (verified):** `npm run typecheck` clean; `npm test` → **296 pass / 0 fail** (7.5 s).
Only untracked change at baseline: the spec file itself.

**Goal:** with `enableProfiles: true` and a `systemOneAPIKey` in the override or global
config file, the `subagent` tool stops offering a `profile` parameter and instead asks the
SystemOne endpoint (`POST {systemOneBaseUrl}/v1/systemone`, a `choice` question over the
configured profile names) which profile each request should run on. Every failure —
no key, unparseable body, timeout, non-2xx, a name not in `config.profiles` — resolves to
`current`, which is exactly today's behaviour. Key absent or null: nothing changes at all.

## Decisions fixed by the spec

1. **Project scope is inert for both keys.** Only the `override` file
   (`$PI_TINYSUBAGENT_CONFIG`, `config.ts:75`) and `global` are consulted, matching
   `config.ts:332-333`. A checked-in project file can neither enable routing (which would
   exfiltrate briefs to a repo-chosen host) nor redirect an inherited key.
2. **`{key, baseUrl}` resolve together, from one file.** The first file that supplies
   `systemOneAPIKey` decides on/off *and* supplies the base URL; a `systemOneBaseUrl`
   anywhere else is inert and warns. A URL-only file never decides.
3. **Routing never fails a spawn.** It only rewrites `request.profile` before the existing
   validation loop; `resolveProfile` inside `spawnOne` (`spawn.ts:40-44`) stays authoritative.
4. **No brief is sent for a spawn that will be refused.** Requests whose agent is not in the
   call-time `discovered.agents` (`tool.ts:90`, used at `:121`) are skipped — not
   `advertisedAgents` (`tool.ts:60`, frozen at registration).
5. **Both schema guards become `enableProfiles && !routingActive(config)`.** This fixes
   `describe.ts:97` (`tasks[].profile`), unconditional today, which advertises a profile that
   `resolveProfile` is guaranteed to refuse when profiles are off.
6. **Candidates exclude `current`** (and any name empty after trim, so a key `" current "`
   cannot route to a decision that renders as `[current]`), capped at 50, and a response with
   no `probabilities` is not trusted. The chooser's result must be a key of `config.profiles`.
7. **Transport is hermetic and cannot throw.** One attempt, 2 s `AbortController` that covers
   the body read, `redirect: "manual"`, injectable `fetch`, `{choice, confidence} | null`.
   No key or URL ever appears in a warning, error, ack, or description.
8. **`SystemOneConfig { apiKey, baseUrl, file }` is a required field** on `TinysubagentConfig`
   (`systemOne: SystemOneConfig | null`) so every construction site must state routing on/off.
9. Four `docs/intent.md` edits plus two doc-comment/layout lines are a prerequisite for code
   (S1) — `docs/intent.md:3-4` is the contract and must be edited deliberately, first.

## Modules

| Module | Deliverable |
|---|---|
| S1 | `docs/intent.md`: the five prerequisite edits — `:31-32` (the `profile` bullet this contradicts), `:144-151` (the "two rules, independent" the atomic key+URL rule amends), `:154` (extend "a repo file can never …"), `:169` (`/subagent-settings` edits only `enableProfiles`/`profiles`; routing keys are hand-edit only), `:91` (`config/` layout: add `src/systemone/`) |
| S2 | `src/config/config.ts`: `SystemOneConfig`, required `systemOne` field, resolver over override+global only, `systemOneBaseUrl` normalisation (strip trailing `/`, `/v1`, `/systemone`), validation (non-string/empty/unparseable/unsupported protocol/loopback), one warning per refused shape, inert-project-scope warning. Update all 11 typed literals. `test/config/config.test.ts` cases |
| S3 | `src/systemone/client.ts` (new): `routeOnce(input, {fetch})` — POST `{model, state:{task, role}, questions:{profile:{type:"choice",instructions,criteria}}}`; returns `{choice, confidence} \| null`, never throws; `test/systemone/client.test.ts` |
| S4 | `src/systemone/route.ts` (new): `routingActive(config)`, `profileCandidates(config)`, `RouteFn` type, `routeProfiles(requests, config, deps)` — builds criteria from `{model, thinking}`, drops unknown/incoherent names to `current`, warns once; `test/systemone/route.test.ts` |
| S5 | `src/present/describe.ts`: both guards `enableProfiles && !routingActive(config)`; description block replaced when routing is active. `test/pi/extension.test.ts` grows a real four-case matrix (needs the `PI_TINYSUBAGENT_CONFIG` seam); `test/config/profiles.test.ts` description cases adjusted |
| S6 | `src/pi/tool.ts`: `route` on `ToolDeps`; routing call between `collectRequests` (`:98`) and the validation loop (`:101-109`), concurrent, skipping unknown agents, overwriting stale `request.profile`; `index.ts` passes the real `RouteFn`; `test/pi/tool.test.ts` (new) integration: fake route → assert per-child argv |
| S7 | Docs + redaction: `index.ts:13` comment ("three things leave the process" → four), `README.md` config section (`:118` `enableProfiles` block) and error table (`:202`), assertions that the key/URL appear in no description, schema, warning, ack, result or failure string |
| S8 | Checkpoint + commit: typecheck, full suite, `npm run smoke:tool`, hand check, `plan.md`/`todo.md` notes |

## Checkpoints

| Checkpoint | After | Expected |
|---|---|---|
| CP0 | — (have it) | 296 pass / 0 fail; typecheck clean @ `415096a` |
| CP1 | S1–S2 | typecheck clean; suite green; new config cases; all 11 literals updated |
| CP2 | S3–S4 | typecheck clean; suite green; client + route cases; no test touches the network |
| CP3 | S5–S6 | typecheck clean; suite green incl. four-case matrix, per-child argv, and every fallback row |
| CP4 | S7–S8 + commit | typecheck clean; suite green; docs updated; one commit |

**S5 and S6 ship in one commit.** S5 alone is a broken intermediate for anyone holding a real
key: the `profile` parameter disappears while routing is not yet wired, so every spawn silently
becomes `current`. Never release between them.

## Boundaries

- **Never:** log, persist, or interpolate the API key (or the base URL) into any model-facing
  string, warning, error, ack, or tool result; send a brief when the agent is unknown; let a
  routing failure fail or delay a spawn beyond the 2 s budget; let project scope decide either
  key; add a dependency (`fetch` only); change `resolveProfile`, `spawnOne`, or the ack shape;
  edit the user's config file.
- **Ask first:** a profile `description` field in the schema; reading the key from an
  environment variable; a key field in `/subagent-settings`; pinning `jev-1.13.0` over the
  `jev-latest` alias; a `systemone` entry in `availableProfileNames`.

## Risks

1. **A required `systemOne` field breaks every typed literal.** Known sites:
   `test/config/profiles.test.ts:15,64,77,89,103,114,124,135`,
   `test/children/spawn.test.ts:147,217`, `scripts/smoke-tool.ts:81-82`. Typecheck in S2 is the
   gate; fix anything it names. (`test/config/config.test.ts` writes untyped JSON via
   `writeConfig(value: unknown)` and needs no `systemOne`.)
2. **A network call in the spawn path can hang the tool.** One attempt, 2 s abort covering the
   body, `redirect: "manual"`; the integration test drives a never-resolving fetch and asserts
   the spawn still runs on `current`.
3. **Test hermeticity.** Tests must make no network call: `route` is injected through
   `ToolDeps`, and a test asserts a throwing `fetch` is never reached.
4. **A developer's real global key would otherwise flip the suite.** `test/pi/extension.test.ts`
   currently reads the real config; the four-case matrix needs
   `PI_TINYSUBAGENT_CONFIG` → temp file (`withEnv` sets only `HERDR_*` today).
5. **`docs/intent.md` is the contract.** S1 is a deliberate, reviewed prerequisite; a later
   reviewer should see the intent edit in the same commit series, not retrofitted.

## Verification

`npm run typecheck` · `npm test` · `npm run smoke:tool` (its config literal changes in S2) ·
`git diff` on the touched files. Hand check where a key exists: set `systemOneAPIKey` in the
global file, spawn one subagent, confirm no `profile` parameter in the tool schema and the
routed `[profile]` in the ack; then corrupt the key and confirm the spawn still runs on
`[current]`.

## Open questions

1. **Is a real System One key available** for the CP4 hand check? If not, the manual
   end-to-end is deferred and the stubbed-route coverage stands in.
2. Pin `jev-1.13.0` instead of the `jev-latest` alias? The spec uses the alias.
3. Does `/subagent-settings` ever gain a redacted key field, or is hand-edit permanent?
   (Spec: out of scope.)
4. ~~Does `README.md` have a config section to extend?~~ Resolved: it has one at `README.md:118-150` (keys, precedence) plus an error table at `:202` — S7 extends both.
