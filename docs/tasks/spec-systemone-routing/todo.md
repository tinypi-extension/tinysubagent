# Todo: SystemOne profile routing

Implements `docs/specs/spec-systemone-routing.md` per
`docs/tasks/spec-systemone-routing/plan.md`. Baseline at `415096a`: typecheck clean,
`npm test` → 296 pass / 0 fail.

- [x] **S1 — contract edits.** `docs/intent.md` only, five deliberate edits, before any code:
  `:31-32` rewrite the `profile` bullet (`profile` is compulsory when `enableProfiles` is true
  *and routing is off*; absent from the schema when routing is on; `"current"` stays the
  implicit profile); `:144-151` amend the "two rules, independent of each other" paragraph with
  the third, deliberately non-independent `{key, baseUrl}` rule (one file, both keys, project
  scope inert); `:154` extend the "a repo file can never …" sentence to routing enablement;
  `:169` state that `/subagent-settings` edits only `enableProfiles`/`profiles.<name>` and the
  routing keys are hand-edit only; `:91` add `src/systemone/` to the repository layout.
  - Files: `docs/intent.md`
- [x] **S2 — resolution.** `src/config/config.ts`: `SystemOneConfig { apiKey, baseUrl, file }`;
  required `systemOne: SystemOneConfig | null` on `TinysubagentConfig`; read both keys from the
  override and global candidates only (`config.ts:332-333`, highest precedence first) with the
  same-file rule — the first file supplying `systemOneAPIKey` decides on/off *and* supplies
  `systemOneBaseUrl`; normalise the URL (trim, strip trailing `/`, `/v1`, `/systemone`); refuse
  non-string, empty, unparseable, non-http(s), and non-loopback-insecure URLs with one warning
  each; warn when a project file supplies either key (inert) and when a `systemOneBaseUrl`
  appears in a file that did not supply the key. Update the 11 typed literals.
  Tests: project key does not enable routing; override beats global; same-file URL wins; a URL
  in a non-deciding file is inert and warns; `/v1` and `/systemone` are stripped; an empty or
  non-string key is `null` with one warning; a non-http scheme is refused; `null` key = routing
  off with no warning.
  - Files: `src/config/config.ts`, `test/config/config.test.ts`, `test/config/profiles.test.ts`,
    `test/children/spawn.test.ts`, `scripts/smoke-tool.ts`
- [x] **S3 — transport client.** `src/systemone/client.ts`: `routeOnce(input, deps)` posts
  `{ model: "jev-latest", state: { task, role }, questions: { profile: { type: "choice",
  instructions, criteria } } }` to `${baseUrl}/v1/systemone` with
  `Authorization: Bearer <key>`; one attempt, `AbortController` at 2 s covering the body read,
  `redirect: "manual"`, response size cap, injectable `fetch` (defaults to `globalThis.fetch`).
  Returns `{ choice, confidence } | null` and **never throws**; no caught error, warning, or
  returned string may contain the key, the URL, or the `Authorization` header.
  Tests (fake fetch, no network): 200 with a valid choice; 401; 429; 500; 422; non-JSON body;
  JSON missing `answers.profile`; a `choice` name absent from `probabilities`; an already-aborted
  signal / `AbortError`; a body that never resolves (timer fires); a 302 (not followed); the
  request body shape and both headers asserted verbatim; the key appears in no returned string.
  - Files: `src/systemone/client.ts`, `test/systemone/client.test.ts`
- [x] **S4 — routing policy.** `src/systemone/route.ts`: `routingActive(config)`
  (`config.enableProfiles && config.systemOne !== null`), `profileCandidates(config)`
  (`availableProfileNames` minus `current`, minus names empty after trim, capped at 50),
  `RouteFn = (input) => Promise<{ choice: string | null; confidence?: number }>`, and
  `routeProfiles(requests, config, deps)` — concurrent over requests, criteria built from each
  profile's `{ model, thinking }`, a returned name accepted only when it is a key of
  `config.profiles` (and not `current`); otherwise the request keeps `profile: undefined`
  (`current`) with one warning naming the reason. No mutation of `config`; no throw.
  Tests: candidates exclude `current` and a `" current "` key; ≤50; routing on/off predicate;
  a valid name is written to `request.profile`; an unknown name, a `current` name, a
  no-`probabilities` answer, and a `null` from the client each leave `current`; one failure does
  not stop the others in a batch; the criteria text carries `model`/`thinking`.
  - Files: `src/systemone/route.ts`, `test/systemone/route.test.ts`
- [x] **S5 — guards + description.** `src/present/describe.ts`: `:51` description block and the
  `:110-112` top-level `profile` property become `enableProfiles && !routingActive(config)`, and
  `:97` (`tasks[].profile`, unconditional today) is brought under the same guard; when routing is
  active the description names the profiles routing chooses among and says the caller does not
  pick. `test/pi/extension.test.ts`: add the `PI_TINYSUBAGENT_CONFIG` seam (temp file) so the
  four-case matrix — `enableProfiles` × routing — is real rather than tautological, keeping the
  `:199` description assertion. `test/config/profiles.test.ts`: adjust the description cases for
  the routing-on text. **Ships with S6 in one commit.**
  - Files: `src/present/describe.ts`, `test/pi/extension.test.ts`, `test/config/profiles.test.ts`
- [x] **S6 — wiring.** `src/pi/tool.ts`: add `route: RouteFn` to `ToolDeps`; between
  `collectRequests` (`:98`) and the validation loop (`:101-109`), when `routingActive(config)`,
  route concurrently over the requests whose agent is in `discovered.agents` and skip the rest
  (no brief leaves the process for a spawn that will be refused); the result overwrites each
  `request.profile` so `spawnOne`'s `resolveProfile` (`spawn.ts:40-44`) still decides the argv.
  `index.ts` passes the real `RouteFn`. **Ships with S5 in one commit.**
  Tests (new `test/pi/tool.test.ts`, fake `route`, no network): two requests in one batch get
  different routed profiles and each child's argv carries its own `--model`/thinking; a routing
  failure spawns on `current`; an unknown agent name triggers no route call; routing off calls
  `route` zero times; a never-resolving route does not block the spawn beyond the budget; the
  ack names the routed profile.
  - Files: `src/pi/tool.ts`, `index.ts`, `test/pi/tool.test.ts`
- [x] **S7 — docs + redaction.** `index.ts:13` doc comment: "only three things leave the
  orchestrator's process" → four (the routing request). `README.md` config section (line ~118
  `enableProfiles` block) and error table (~202): document both keys, that routing removes the
  `profile` parameter, that `{key, baseUrl}` must live in one file, that project scope is inert,
  and that every failure falls back to `current`. Assertions that the key and URL appear in no
  tool description, parameter schema, `configWarnings`, ack, result text, or failure string.
  - Files: `README.md`, `index.ts`, `test/pi/extension.test.ts`, `test/systemone/client.test.ts`
- [x] **S8 — checkpoint + commit.** `npm run typecheck` clean; `npm test` all pass / 0 fail;
  `npm run smoke:tool`. Hand check if a key exists (see open question 1): key set → no `profile`
  parameter, routed `[profile]` in the ack; key corrupted → spawn still runs on `[current]`.
  Result recorded here.
  - Files: `docs/tasks/spec-systemone-routing/plan.md`, `docs/tasks/spec-systemone-routing/todo.md`

## Implementation notes

_Implemented as four review rounds (S1+S3, S2+S4, S5+S6, S7), one commit._

**Checkpoints (all `npm run typecheck` clean):**

| Checkpoint | Result |
|---|---|
| CP0 (baseline @ `415096a`) | 296 pass / 0 fail |
| CP1 (S1+S2) | 336 pass / 0 fail; 13 new config cases; `systemOne: null` added to the typed literals in `test/config/profiles.test.ts` and `test/children/spawn.test.ts:147` (only two sites needed it; `scripts/smoke-tool.ts` writes untyped JSON) |
| CP2 (S3+S4) | 336 pass / 0 fail; client 9 tests, route 17 tests; every test injects its `fetch`/`RouteFn`, none touches the network |
| CP3 (S5+S6, one commit) | 342 pass / 0 fail; four-case `enableProfiles x routing` matrix in `test/pi/extension.test.ts` driven by `PI_TINYSUBAGENT_CONFIG`; 6 integration tests in `test/pi/tool.test.ts` asserting per-child argv |
| CP4 (S7+S8) | 345 pass / 0 fail; README + redaction assertions; committed |

**Deviations from the plan**

- `routingActive(config)` has a third clause — `profileCandidates(config).length > 0` — beyond the
  plan's two-term form, per the spec's failure-table row "routing active but no named profiles
  exist -> routing inactive, no calls". Without it a key with no profiles would POST an empty
  criteria set instead of doing nothing.
- `normalizeBaseUrl` and `DEFAULT_SYSTEMONE_BASE_URL` live in `src/systemone/client.ts` and are
  imported/re-exported by `src/config/config.ts`, so normalisation has one home (the plan placed it
  in S2, the spec's file list in S3).
- `profileCandidates` drops any name that is not already trimmed, not just `" current "`: an
  untrimmed key cannot round-trip through the chooser, whose rendered answer resolves by exact key.
- Rejected-choice warnings are emitted once per rejected request (each names its own request), not
  once per batch; only the >50 cap warning is per batch.
- `routeProfiles` warnings are appended to the model-facing result text; `renderResult` is
  deliberately unchanged (the ack shape stays as it was).

**Open items carried forward**

- Open question 1: no real SystemOne key was available in this environment, so the manual
  end-to-end hand check (routed `[profile]` in a real ack, then a corrupted key falling back to
  `[current]`) is deferred. The stubbed-route coverage in `test/pi/tool.test.ts` stands in: it
  asserts the routed per-child argv, the fallback, and the never-resolving-fetch budget.
- `npm run smoke:tool` fails here for a pre-existing, environmental reason unrelated to this
  feature: the developer's real `~/.pi/agent/agents/worker.md` allowlist lists `send_dmail`, which a
  fresh child pi does not provide, so the smoke's "no unexpected warnings" guard trips. The run
  itself reaches registration, capability check, spawn and ack, and shows `[current]` with routing
  off.
