# Spec: SystemOne profile routing (`systemOneAPIKey` + `systemOneBaseUrl`)

Status: proposed. Nothing here is built yet.

## What it is

When a SystemOne API key is configured, the orchestrator stops choosing profiles by
hand. The `subagent` tool loses its `profile` parameter entirely, and for each request a
SystemOne model (a fast structured-decision model, not a text generator) is asked to name
one of the configured profiles. The name it returns is then resolved exactly the way a
hand-written name is resolved today — same code, same `{ model, thinking }` outcome.

If no such key is configured, nothing changes: the `profile` parameter is present and the
orchestrator picks.

**This introduces the first outbound HTTP call in the repository.** Today the extension
makes none — `scripts/smoke-provider-error.ts:57-62` constructs a *local* `127.0.0.1`
stub, and the only other outbound effects are `execFile` calls to `herdr`
(`src/herdr/cli.ts`). The new call is also the first thing that sends task text to a third
party.

> **Superseded when `classifierModel` is set.** A configured `classifierModel` routes
> profiles in process through pi's model registry instead of this HTTP call; the three
> SystemOne keys are then ignored. See
> [spec-remove-systemone-tui-rows.md](./spec-remove-systemone-tui-rows.md) (Part A).

## Wire contract (verified, not assumed)

The endpoint, auth, request and response shapes below come from TypeSafe's own OpenAPI 3.1
document (`https://api.typesafe.ai/openapi.json`, paths: exactly `/v1/systemone` and
`/v1/models`) and its API reference (`https://docs.typesafe.ai/api`). Model *names* are the
one exception: the document gives `jev-latest` as the only `example`, and defers the real
list to `GET /v1/models`, which is account-scoped. `jev-1.13.0` and `jev-preview` come from
the docs pages, not the schema.

| | |
|---|---|
| Endpoint | `POST {baseUrl}/v1/systemone` |
| Auth | `Authorization: Bearer <key>` (security scheme `HTTPBearer`) |
| Model | `jev-latest` (schema-confirmed example; `jev-1.13.0` / `jev-preview` per docs prose only) |
| Request | `{ state, model, questions }` — all three required |
| `state` | `string \| object \| array` |
| `questions` | map of `id` → `Question`, at least 1; the id is echoed back, never sent to the model |
| Choice question | `{ type: "choice", instructions?, criteria }` — `criteria` required, a map of label → description |
| `criteria` value | any of: string, object, array, or `null`. A plain description string is the variant we use |
| Label count | no bound in the schema. The prose reference mentions a 255 limit; treat it as a practical ceiling, and enforce our own cap (below) anyway |
| Response | `{ model, answers, usage }`, all required; `answers[<id>]` = `{ type:"choice", choice, confidence, probabilities }`, all four required |
| `choice` | string, the highest-probability label |
| `probabilities` | number map, ≈1 total — calibrated per-label probability |
| `confidence` | number 0–1, a derived statistic |

It is **not** OpenAI-compatible: there is no `/v1/chat/completions`, no `messages` array,
and the strings `temperature`, `top_p` and `seed` do not occur anywhere in the schema. The
endpoint is the same path on the providers that offer the model, which is why the base URL
is configurable.

## Prerequisite: `docs/intent.md` must be edited first

`docs/intent.md:3-4` is explicit: *"This is the contract. If a change contradicts a line
here, that line must be edited first, deliberately."* Four lines there need deliberate
edits before code:

| intent.md | Why | Edit |
|---|---|---|
| `:31-32` | *"`profile` is compulsory when `enableProfiles` is true; absent from the schema when false."* Routing makes it absent while `enableProfiles` is true. | Reword to add "…and when SystemOne routing is configured." |
| `:144-151` | *"Two rules, independent of each other… The files layer, they do not replace."* Routing adds a third rule that is deliberately **not** independent: the key and its destination resolve as one unit. | State the new rule and why it is atomic. |
| `:154` | *"a repo file can never disable profiles that were already working."* The same promise is now extended to routing: a project file can neither enable nor disable it. | Extend the sentence to routing. |
| `:169` | The settings screen *"edits `enableProfiles` and `profiles.<name>.{model, thinking}` and nothing else."* | Add that the routing keys are hand-edit only (see Out of scope). |

Also: `docs/intent.md:91` (the `config/` line in Repository layout) gains a `systemone/`
entry, and the comment at `index.ts:13` — *"Only three things leave the orchestrator's
process"* — becomes four, because of the HTTP call. Neither is a contract change; both are
part of the same commit.

## Config surface

Two new top-level keys, both optional, both read **only from the override or global
scope**:

```jsonc
// ~/.pi/agent/tinysubagent.jsonc  (global) — or $PI_TINYSUBAGENT_CONFIG when set
{
  "enableProfiles": true,
  "profiles": {
    "light": { "model": "cc/deepseek/deepseek-v4.1-flash", "thinking": "low" },
    "pro":   { "model": "cc/z-ai/glm-5.3-flash",          "thinking": "high" }
  },
  "systemOneAPIKey": "sk-...",
  "systemOneBaseUrl": "https://api.typesafe.ai"
}
```

Resolved shape on `TinysubagentConfig` (`src/config/config.ts:36-48`), added next to
`enableProfiles`:

```ts
/**
 * SystemOne routing, resolved as one unit from one trusted file. `null` when no key
 * was configured (or the configured one was refused). Non-null only means a key was
 * accepted — routing is still off if `enableProfiles` is false or there are no named
 * profiles. `baseUrl` never has a trailing slash and never ends in `/v1` or `/systemone`.
 */
export interface SystemOneConfig {
	apiKey: string;
	baseUrl: string;
	/** Absolute path of the file that supplied both. Used in messages. */
	file: string;
}
```

The field is **required** on `TinysubagentConfig` (`systemOne: SystemOneConfig | null`),
not optional: every construction site should have to say out loud whether routing is on.
That includes the hand-built config literals in `test/config/profiles.test.ts:15,64,77,89,100,112,124,135`,
`test/children/spawn.test.ts:147`, `test/config/config.test.ts`, and the `scripts/smoke*.ts`
fixtures — each gains `systemOne: null` and nothing else changes in them.

### Which files may turn it on

| Scope | A key or URL here |
|---|---|
| `override` (`$PI_TINYSUBAGENT_CONFIG`, `src/config/config.ts:75`; when set it is the only file read — `docs/intent.md:138`) | honoured |
| `global` (`<agentDir>/tinysubagent.jsonc`) | honoured |
| `project` (`<cwd>/.pi/tinysubagent.jsonc`) | **inert, with one warning** — it can neither enable nor disable routing |

| | |
|---|---|
| Key honoured only from override/global | **Chosen.** A repository is untrusted input. A checked-in project file setting `systemOneAPIKey` — or a same-file `systemOneBaseUrl` — would otherwise turn routing on by itself and send every task brief to a host the repo chose. Nothing is stolen and no user config is read, which is exactly what makes it likely: it needs no credential. `docs/intent.md:156` goes further and tells repos to *commit* `.pi/tinysubagent.jsonc`, so that file is expected to be present and untrusted by design — the last place a credential or a destination should be readable from. Refusing the whole scope is one rule, symmetric with `docs/intent.md:154` (*a repo file can never disable profiles that were already working*), and it means a project file cannot silently switch routing off either. |
| Allow project scope, warn loudly at `session_start` | Rejected as the default — the warning arrives after the first spawn it should have prevented, since routing happens at spawn time, not session start. |
| Allow project scope when a human confirms | Rejected — adds an interactive prompt to a non-interactive path, and there is no existing confirm seam at spawn time. |

This is a policy choice, not a mechanism: it lives in one predicate in the loader and is
reversible in one line if per-project keys are ever wanted.

### Resolution rule

Consult the same candidate set `loadConfig` already uses
(`src/config/config.ts:332-333`: the override file alone when `PI_TINYSUBAGENT_CONFIG` is
set, otherwise project + global — see `docs/intent.md:138`), but skip project scope for
these two keys. Among the files that remain:

1. Take the **highest-precedence** file that has `systemOneAPIKey`, comparing presence,
   not truthiness — the same idiom `enableProfiles` uses at
   `src/config/config.ts:347-351`. (Note the loader's loop runs
   `[...candidates].reverse()`, lowest-first; the resolver must scan highest-first, so it
   cannot reuse that loop order.)
2. `baseUrl` comes from **that same file**. A `systemOneBaseUrl` in a different file is
   ignored, with a warning.
3. If no file supplies a key, routing is off; a `systemOneBaseUrl` with no key beside it is
   inert and warns. A URL alone never decides anything.

| Value in the deciding file | Result |
|---|---|
| `"systemOneAPIKey": "sk-…"`, `"systemOneBaseUrl": "https://x"` | on, `baseUrl = https://x` |
| `"systemOneAPIKey": "sk-…"`, no URL | on, `baseUrl = https://api.typesafe.ai` |
| `"systemOneAPIKey": null` | off — the key is explicitly cleared |
| `"systemOneAPIKey": ""` or whitespace | off, one warning |
| `"systemOneAPIKey": 42` (not a string, not null) | off, one warning |
| `"systemOneBaseUrl"` with no key in the same file | off, one warning |
| key in a **project** file | inert, one warning naming the scope |

Defaulting to `https://api.typesafe.ai` when the deciding file omits the URL is safe now
that the URL must come from the same trusted file as the key: there is no scope in which
the credential and its destination can be supplied by different parties. That keeps "set
the key and it works" true.

`baseUrl` validation: must parse as a URL; `http:` permitted only for `localhost`,
`127.0.0.1` and `[::1]`, otherwise `https:`. Anything else warns and turns routing off. A
trailing `/v1` or `/systemone` is stripped when normalizing, so both
`https://openrouter.ai/api` and `https://openrouter.ai/api/v1` work.

## Activation

Routing is active when **all** of these hold:

1. `enableProfiles === true`;
2. `systemOne` is non-null and not refused;
3. at least one named profile exists in `config.profiles`.

Condition 1 was confirmed deliberately: routing has nothing to route *to* when profiles are
disabled, and the schema comment at `src/present/describe.ts:72-73` already ties the
parameter's existence to profiles being enabled. Condition 3 exists because `current` is
never a candidate (below), so a profile set containing only the built-in means an empty
candidate list. When it fails, the existing warning at `src/config/config.ts:357-361`
already fires; extend it to name the routing keys so the reason is not mysterious.

## Schema changes

`profile` disappears from **both** places it is currently declared when routing is active:

- the top-level property, today gated on `config.enableProfiles` at
  `src/present/describe.ts:110-112` — guard becomes `enableProfiles && !routingActive`;
- the per-task property inside the `tasks` array item at `src/present/describe.ts:97`,
  which is **unconditional today**.

The per-task guard becomes `enableProfiles && !routingActive` as well, not just
`!routingActive`. That fixes a pre-existing inconsistency as a side effect: with
`enableProfiles: false` the schema currently advertises a per-task profile that
`resolveProfile` is guaranteed to refuse. Removing it makes both locations agree with
`src/present/describe.ts:72-73`.

The tool description's `Profiles:` block (`src/present/describe.ts:51-58`, the text itself
at `:54`) is replaced when routing is active by a line stating that a profile is chosen
automatically per task and cannot be set, so the model is not silently missing a knob it
has seen before.

### A supplied `profile` while routing is active

Ignored, and overwritten by the routing outcome. The schema no longer offers the field, so
any value that arrives is a stale session replay, and the spawn still has a correct answer
available — failing a spawn over a knob that no longer exists is worse than routing through
it. This is a deliberate exception to the "refuse stale replays loudly" precedent at
`src/config/profiles.ts:8-11`; that precedent covers an *unhonourable* request, and this
one is honourable.

## Where the code goes

Two new modules, matching the existing `src/herdr/` integration shape. Neither changes
`src/config/profiles.ts` or `src/children/spawn.ts`.

**`src/systemone/client.ts`** — transport, no policy. `normalizeBaseUrl`, `buildBody`,
one `fetch` with an `AbortController` and **`redirect: "manual"`** (so a redirect is a
non-2xx and never re-sends the `Authorization` header to another origin). Takes an
injectable `fetch` for tests. Signature:
`routeOnce(input): Promise<{ choice: string; confidence: number } | null>`. It **never
throws** — every failure resolves to `null`. `confidence` is returned for observability
only; nothing in this spec acts on it.

**`src/systemone/route.ts`** — policy. Candidates =
`availableProfileNames(config)` (`src/config/profiles.ts:42-44`), excluding the built-in
and any key that is empty after trimming, then mapped to `criteria` entries. Validates the
returned name against `config.profiles` exactly, so a name that is not a configured key is
treated as `null`, not as a routed answer.

**Call site: `src/pi/tool.ts`**, between `collectRequests` (`src/pi/tool.ts:98`) and the
profile-validation loop (`src/pi/tool.ts:101-109`):

```
requests ──> routing active? ──> request's agent is known? ──> route concurrently ──┐
                                        │ no                                       │
                                        └──────> not routed, no outbound call      │
                                                                                   v
                                              request.profile = name ?? undefined ──┐
                                                                                   │
                                        existing path unchanged ──> spawnOne ──> resolveProfile
```

Consequences of putting it here, all deliberate:

- **No duplicate code path.** `spawnOne` keeps calling `resolveProfile` authoritatively
  (`src/children/spawn.ts:40-44`), and the resolved triple still reaches the child's argv
  through `buildPiArgv` (`src/children/spawn.ts:94`; `model` and `thinking` at `:99-100`)
  and the ack through `src/children/spawn.ts:184` → `src/pi/tool.ts:144`.
- **Fallback is the existing behaviour**, not a new one: leaving `request.profile`
  `undefined` is precisely today's `current` path (`src/config/profiles.ts:87-89`).
- **Requests whose agent is unknown are never routed.** Agent existence is currently only
  checked inside `spawnOne` (`context.agents.find`), so an unmatched request would
  otherwise send a full brief to a third party for a spawn that is about to be refused.
  The pre-loop checks `discovered.agents` — the same call-time list that goes into
  `SpawnContext` (`src/pi/tool.ts:90`, `:121`) — using the same name comparison, and skips
  routing for a request that cannot spawn. `advertisedAgents` (`src/pi/tool.ts:60`,
  frozen at registration for `process.cwd()`) is **not** used for this.
- **Whole batches are routed concurrently** (`Promise.all`), so the added latency is one
  timeout for the batch, not one per task. Routing inside the sequential launch loop
  (`src/pi/tool.ts:134-135`) would multiply the worst case by the number of panes.
- The validation loop at `src/pi/tool.ts:101-109` keeps working unchanged; with a routed or
  absent name it can only succeed.

Timeout: **2000 ms total, one attempt, no retries**, covering the body read as well as the
headers (a single `AbortController` around both `fetch` and `.json()`, so a slow body
cannot outlive the budget). The documented latency is 70–500 ms, so 2 s is generous, and
the alternative is worse: a retry doubles the worst-case delay before any pane opens, in
exchange for a decision that has a free fallback. The tool's contract is that it returns as
soon as the panes are open (`src/present/describe.ts:38`), and this call sits on that path.

## What gets sent

```jsonc
{
  "model": "jev-latest",
  "state": {
    "role": { "name": "worker", "description": "<the role's description from its frontmatter>" },
    "task": "<the full task brief, verbatim>"
  },
  "questions": {
    "profile": {
      "type": "choice",
      "instructions": "Which model/thinking profile should run this task? Choose the cheapest profile that can do it well, weighing how much reasoning and tool use it needs.",
      "criteria": {
        "light": "model cc/deepseek/deepseek-v4.1-flash, thinking low",
        "pro": "model cc/z-ai/glm-5.3-flash, thinking high"
      }
    }
  }
}
```

The role comes from `discovered.agents`, so the router sees the same role the child will
run as. The candidate list is the real configured profile set, capped at 50 labels (well
under the prose 255) with the remainder dropped and one warning — so adding a profile to
the config file is the whole of "teach the router a new profile". There is no second list.

## Failure → `current`

Routing never fails a spawn and never aborts a batch. Every row below resolves to
`request.profile = undefined`, which is today's behaviour, and the pane opens as usual.

| Failure | Result |
|---|---|
| DNS, connection refused, TLS error | `current` |
| Timeout (2 s) / abort, headers or body | `current` |
| `401` (revoked or wrong key) | `current` |
| `429` rate limited, `529` overloaded | `current` |
| Any other non-2xx, including `3xx` (redirects are not followed) | `current` |
| `422` validation error | `current` |
| Non-JSON body, JSON of the wrong shape | `current` |
| Response larger than 1 MB | `current`, read abandoned |
| `answers.profile` missing, or `type !== "choice"` | `current` |
| `choice` not a string | `current` |
| `choice` is a string but not a key of `config.profiles` | `current` |
| `probabilities` absent or nonsense | `current`, and the choice is **not** trusted — an answer without its distribution is an incomplete answer |
| Request's agent name is not in `discovered.agents` | `current`, **and no HTTP call is made** |
| Some requests in a batch route, others fall back | Each keeps its own outcome; the batch proceeds normally |
| Routing active but no named profiles exist | Routing inactive (condition 3), no calls |

Nothing is retried, nothing is queued, nothing is cached, nothing is written to disk.

A failed call is not silent: `routeOnce` reports one fixed, redacted reason through its
`onFailure` callback (`timeout`, `network error`, `HTTP <status>`, `the answer was too
large`, `the answer was not JSON`, `the answer was not a profile choice`, `no fetch
implementation is available`, `the request was cancelled before it was sent`), and
`createRouteFn` turns it into the request's one warning:
`tinysubagent: systemOne routing failed (HTTP 401); keeping "current".` The reason is
chosen by the client, never quoted from a caught error or a response body, so it cannot
carry the key, the URL, or a provider message. A success emits no warning at all.

## What the orchestrator sees

`[profile]` in the spawn ack already carries the resolved name
(`src/present/ack.ts:44-52`, rendered at `src/present/ack.ts:60` and
`src/present/ack-render.ts:56`), so a routed spawn shows `[pro]` with no presentation
change. Under routing this yields a usable invariant, worth stating in the README:

> With routing on, `[current]` in a spawn acknowledgment means the SystemOne call did not
> produce a decision, because `current` is never a routing outcome.

An explicit "(routing unavailable)" clause in the ack is therefore **not** part of this
spec: it would touch `src/present/ack.ts`, `src/present/ack-render.ts` and both their tests
to restate information the invariant already carries. Cheap to add later if the inference
proves too subtle in practice.

## Where the key must not appear

The key is a credential and is never interpolated into anything a model or a user reads:
not `configWarnings` (surfaced through `ctx.ui.notify` at `src/pi/lifecycle.ts:27`), not
the tool description, not a tool error, not the ack, not a result message. Caught errors
are mapped to a fixed string — an exception message or a URL is never passed through, and
the `401` row above degrades to `current` with the fixed reason `HTTP 401`, which is also
what keeps a bad key out of the transcript. Tests assert this.

## Out of scope

- No profile discovery, no new profile fields, no change to how a profile resolves.
- No `systemOneModel`, `systemOneTimeout`, per-role routing rules, or per-project overrides
  (a project can neither enable nor disable routing — see the scope table).
- No editing of the routing keys from `/subagent-settings` (`src/config/draft.ts`,
  `docs/intent.md:169`): a credential needs a secret-entry flow, not the existing
  `y/n` confirm over a config document, and the settings screen may write a file that ends
  up committed. Hand-edit only in this spec.
- No confidence thresholding, no "try the cheap profile then escalate", no cost tracking.
  `confidence` is parsed and validated but not acted on.
- No key from anywhere but the config file — not `process.env`, not the `env` map, not a pi
  setting. The `env` map stays what it is: variables exported into the child's shell
  (`src/config/config.ts:40`, `src/config/config.ts:288-312`).
- No proxy support, no custom headers, no provider-specific shapes. Node's `fetch` ignores
  `HTTP_PROXY`/`HTTPS_PROXY`; a user behind a proxy gets the fallback behaviour, not a
  working route.
- No caching or memoization of routing decisions across spawns.
- No hot reload, consistent with `docs/intent.md:177-179`.
- No change to `subagent_report`, to steering, or to batch settling.

## Security and privacy

- Enabling the key means **every task brief leaves the machine** and is readable by the
  provider at `systemOneBaseUrl`. Briefs contain whatever the orchestrator put in them,
  including code and file contents. This is the cost of the feature and belongs in the
  README next to the config example.
- Project scope being inert is a security control: a repository cannot turn routing on,
  cannot point it at a host, and cannot turn it off. Combined with the same-file
  `{key, baseUrl}` rule, no credential and no destination can be supplied by different
  parties.
- The key is only as secret as the file holding it. `http:` base URLs are refused outside
  loopback, so a key cannot be sent in clear text by misconfiguration.
- The 64k-token context limit and the 250k-token/sec, 1200-req/min rate limits are the
  provider's, not ours. A brief too large to route simply falls back.

## Tests

The four-case matrix (`enableProfiles` × routing) needs a config the test controls. The
only existing seam is the override file: `loadConfig` reads
`$PI_TINYSUBAGENT_CONFIG` alone when it is set (`src/config/config.ts:75`,
`docs/intent.md:138`). The test helper must point that variable at a temporary file — the
current helper only sets `HERDR_*` variables, so without this the matrix cannot be driven
and a developer's real global key would flip the results.

Adapted, because they pin the current contract:

- `test/pi/extension.test.ts:178` — **"the profile parameter exists exactly when profiles
  are enabled"** asserts `has("profile") === config.enableProfiles`
  (`test/pi/extension.test.ts:192`) and becomes the four-case matrix, plus the same
  assertion for `tasks[].profile`. `test/pi/extension.test.ts:199`
  (`description.includes("Profiles:")`) also breaks under routing and changes with it.
- The required `systemOne` field means every **typed** config literal gains
  `systemOne: null` and its assertions are otherwise untouched:
  `test/config/profiles.test.ts:15,64,77,89,103,114,124,135` and
  `test/children/spawn.test.ts:147,217`. The `test/config/config.test.ts` fixtures are
  plain JSON documents (`writeConfig(value: unknown)`, `test/config/config.test.ts:28`),
  not `TinysubagentConfig` values, so they are genuinely unchanged.
  `test/children/spawn.test.ts:171` is otherwise untouched, as are
  `test/present/ack.test.ts:21,40,43` — ack rendering is already `null`-tolerant
  (`src/present/ack.ts:48-50`).

New:

- `test/systemone/client.test.ts` — base-URL normalization table (`…`, `/v1`,
  `/systemone`, trailing slash; `http://localhost` allowed, `http://` otherwise refused);
  the exact `Authorization: Bearer` header; the request body matches the example above;
  timeout aborts a slow body, not just slow headers; `redirect: "manual"` is set; each row
  of the failure table maps to `null`; success parses `choice` and `confidence`.
- `test/systemone/route.test.ts` — `criteria` is built from `config.profiles` and excludes
  `current`; a name that is not a configured key → `null`; missing `probabilities` →
  `null`; the candidate cap drops the remainder with one warning; a public config shape
  (`{ enableProfiles: true, systemOne: {...}, profiles: {...} }`) routes, and `systemOne: null`
  does not.
- `test/config/config.test.ts` — a project-scope key is inert and warns once; `null` clears
  an inherited key; a non-string key warns once and stays off; an empty string warns and
  stays off; a base URL from a different file than the key is ignored with a warning; an
  invalid base URL warns and turns routing off; a `baseUrl` of `http://` outside loopback
  is refused; the URL defaults to `https://api.typesafe.ai` when the key's own file omits
  it; the override file is consulted when `PI_TINYSUBAGENT_CONFIG` is set.
- `test/pi/tool.test.ts` (new) — **integration**: with a stubbed `routeOnce` returning two
  different names, a two-task batch produces two launch scripts whose `--model` and
  thinking flags match the two routed profiles; an unknown agent name makes **no** routing
  call and still fails the way it does today; a batch where one route returns `null` and
  one returns a name yields one `[current]` and one routed child.
- `test/pi/extension.test.ts` — routing on: no `profile` in either schema location, the
  description says the profile is automatic, and a request carrying a stale `profile` is
  routed anyway.
- Redaction — with a recognisable fake key, assert the key string appears in none of: the
  tool description, the schema, `loadConfig` warnings, the ack line, the tool result text,
  and the string returned by `routeOnce` on every failure row.

## Verification

```
npm test          # node --test test/**/*.test.ts
npm run typecheck # tsc --noEmit
npm run smoke:tool
```

Manual, with a real key: one spawn to confirm a routed `[profile]` in the ack, and one with
the key deliberately corrupted to confirm `[current]` and a normal spawn.

## Open items

- **Determinism is not documented.** The schema has no `temperature`/`seed`, and the vendor
  claims consistency ("similar answers for similar inputs"), not determinism. The same brief
  may route to a different profile on two runs. Acceptable here — the fallback is safe and
  every profile is usable — but routing is not a guarantee.
- `jev-latest` is an alias that moves; the schema-confirmed example is all the OpenAPI
  document gives. Pin `jev-1.13.0` if routing behaviour must be reproducible.
- Key provisioning is early-access and gated; no free tier or sandbox key is documented.
  Whether keys are org-scoped is not documented either; assumed account-scoped.
- No published latency SLO (70–500 ms is a marketing figure); the 2 s timeout is our
  choice, not the vendor's number.
