# PI-SIDE SURFACE (current HEAD)

Repo: `/Users/tinyphat/.pi/agent/extensions/subagent` @ `e620fdc` ("feat: advertise agent descriptions in the subagent tool description").

---

## 0. Module map (load entry)

`index.ts:1-106` — entry point. Load-time order (lines 60-77):

```ts
// index.ts:60-77
const MODULE_PATH = fileURLToPath(import.meta.url);

// /reload re-imports this entry, but src/herdr-tools/runtime.ts is module-cached
// and survives with its watchers, event stream, and abort controller still live.
// Re-arm on every import so the previous module's watchers are aborted and its
// event stream is closed before anything new is armed.
runtime.rearm();
runtime.setModulePath(MODULE_PATH);

// Baked once at load time: profile + agent names advertised in tool
// descriptions and parameter hints (see src/advert.ts).
const advert = buildAdvertContext();

export default function (pi: ExtensionAPI) {
	// Tool-name source for `*` pattern expansion in tool lists (codegraph_*).
	// Lazy by design: expansion runs at spawn time, when the registry (built-in
	// + extension + MCP tools) is complete. Re-assigned on every import, so a
	// /reload re-points it at the fresh pi handle.
	setToolNameSource(() => pi.getAllTools().map((tool) => tool.name));

	// Herdr branch requires BOTH the herdr environment (panes to launch into)
	// AND the explicit opt-in (`"subagent": { "herdr": true }` in settings.json).
	// Anything else falls back to the blocking tool.
	if (isInsideHerdr() && isHerdrEnabled()) {
		registerHerdrBranch(pi, advert);
		return;
	}

	// Outside herdr: the original blocking tool, registered exactly as before
	// the herdr migration (single + parallel, one blocking result).
	registerBlockingTool(pi, advert);
}
```

---

## 1. AGENT DEFINITIONS — `src/agent-defs.ts` (309 lines)

### 1a. Frontmatter parser: pi's `parseFrontmatter` (real YAML), NOT a homegrown regex

`src/agent-defs.ts:16-18` (import), `:76-93` (cursor helpers):

```ts
// src/agent-defs.ts:16-18
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig } from "./agents.ts";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
```

```ts
// src/agent-defs.ts:76-93
type AgentFrontmatter = Record<string, unknown>;

/** Frontmatter string field; non-string YAML scalars (numbers, bools) are ignored. */
function fmString(fm: AgentFrontmatter, key: string): string | undefined {
  const v = fm[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Frontmatter boolean field. `parseFrontmatter` runs a real YAML parser, so
 * `spawning: true` arrives as boolean `true`; the unquoted strings "true"/
 * "false" (the reference contract's spelling) are accepted for compatibility.
 */
function fmBoolean(fm: AgentFrontmatter, key: string): boolean | undefined {
  const v = fm[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}
```

### 1b. Exact fields harvested, body → system prompt, error handling

`src/agent-defs.ts:106-155` (verbatim):

```ts
/**
 * Parse one agent-definition markdown file.
 *
 * Returns null when the content has no frontmatter block or malformed YAML —
 * callers (discovery loops) skip the file rather than fail the directory.
 * `fallbackName` is used when no `name:` field is present (the file name).
 */
export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  // No frontmatter block at all → not an agent definition. parseFrontmatter
  // would happily return empty frontmatter + the whole content as body.
  if (!content.startsWith("---")) return null;

  let frontmatter: AgentFrontmatter;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
  } catch {
    // Malformed YAML: skip the file (see parseAgentDefinition doc comment).
    return null;
  }

  const systemPromptMode = fmString(frontmatter, "system-prompt");
  const disableModelInvocation = fmBoolean(frontmatter, "disable-model-invocation");

  return {
    name: fmString(frontmatter, "name") ?? fallbackName,
    description: fmString(frontmatter, "description"),
    model: fmString(frontmatter, "model"),
    tools: fmString(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: fmString(frontmatter, "skill") ?? fmString(frontmatter, "skills"),
    thinking: fmString(frontmatter, "thinking"),
    denyTools: fmString(frontmatter, "deny-tools"),
    spawning: fmBoolean(frontmatter, "spawning"),
    autoExit: fmBoolean(frontmatter, "auto-exit"),
    interactive: fmBoolean(frontmatter, "interactive"),
    sessionMode: parseSessionMode(fmString(frontmatter, "session-mode")),
    cwd: fmString(frontmatter, "cwd"),
    cli: fmString(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation: disableModelInvocation === true,
  };
}
```

Frontmatter keys consumed: `name`, `description`, `model`, `tools`, `system-prompt`, `skill`/`skills`, `thinking`, `deny-tools`, `spawning`, `auto-exit`, `interactive`, `session-mode`, `cwd`, `cli`, `disable-model-invocation`. `body` is the md body (the system prompt). No `systemPrompt` string is built here — `body` is carried and applied later in launch/run.

`src/agent-defs.ts:96-104`:

```ts
function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return "standalone";
  }
  return undefined;
}
```

Types (`src/agent-defs.ts:34-54`, `:63-73`):

```ts
export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}
```

```ts
/** Tools that are gated by `spawning: false` */
export const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }
  return denied;
}
```

### 1c. Discovery directories + precedence (agent-defs path)

`src/agent-defs.ts:157-201` (verbatim):

```ts
export function getAgentConfigDir(): string {
  return getAgentDir();
}

/**
 * Default agent-def directories, first match wins: the project dir beats the
 * user dir, matching the kept discovery's precedence (project over user).
 *
 * The list is injectable everywhere it is consumed so tests (and the herdr
 * path, which reuses agents.ts discovery) can point it at arbitrary dirs.
 */
export function defaultAgentDefDirs(cwd: string = process.cwd()): string[] {
  return [join(cwd, CONFIG_DIR_NAME, "agents"), join(getAgentDir(), "agents")];
}

/**
 * Load one agent's defaults by name from a list of def directories.
 * Directories are injectable (see defaultAgentDefDirs for the default);
 * the first directory containing `<name>.md` wins. Never writes.
 */
export function loadAgentDefaults(
  agentName: string,
  dirs: readonly string[] = defaultAgentDefDirs(),
): AgentDefaults | null {
  for (const dir of dirs) {
    const p = join(dir, `${agentName}.md`);
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }
  return null;
}

/** Agent-def defaults for a discovered agent: parse the discovered file itself. */
export function loadAgentDefFor(agentConfig: AgentConfig): AgentDefaults | null {
  try {
    const parsed = parseAgentDefinition(readFileSync(agentConfig.filePath, "utf8"), agentConfig.name);
    if (parsed) return parsed;
  } catch {
    // fall through to directory lookup below
  }
  return loadAgentDefaults(agentConfig.name, [dirname(agentConfig.filePath)]);
}
```

Other exported helpers (same file, lines 203-309): `resolveSubagentPaths`, `getDefaultSessionDirFor`, `resolveLaunchBehaviorStandalone` (always `{ taskDelivery: "artifact" }`), `resolveEffectiveInteractive`.

```ts
// src/agent-defs.ts:293-309
export function resolveEffectiveInteractive(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}
```

### 1d. Discovery + precedence (the actually-used `agents.ts` path)

`src/agents.ts:1-21`:

```ts
/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}
```

Hard requirement for discovery — BOTH `name` and `description` must be strings, else the file is silently skipped (`src/agents.ts:99-115`):

```ts
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
```

Malformed YAML → `continue` (file skipped, directory survives) — `src/agents.ts:86-98`:

```ts
		let frontmatter: AgentFrontmatter;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
		} catch {
			// Frontmatter is real YAML and throws on malformed input. Skipping the file is
			// the only safe response: this loop runs at extension-load time as well as per
			// call (index.ts discovers agents on module load to advertise their names), and
			// loader.js turns any throw during load into a null extension — one bad file
			// would silently remove the whole subagent tool. Same policy as parseToolList
			// above: a single bad file shortens the list, it never takes down the directory.
			continue;
		}
```

`tools:` accepts string OR array (`src/agents.ts:49-60`):

```ts
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}
```

Discovery dirs + precedence (`src/agents.ts:131-160`):

```ts
function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
```

**Precedence on name collision (scope `"both"`): project wins** — user agents are inserted into the Map first, then project agents overwrite them. Project dir is the *nearest ancestor* `.pi/agents` (`CONFIG_DIR_NAME` = `.pi`). `~/.pi/agent/agents` is the user dir (`getAgentDir()`).

---

## 2. AGENT DISCOVERY + ADVERT — `src/advert.ts` (99 lines)

`src/advert.ts:20-36` (interface + function head):

```ts
export interface ToolAdvert {
	registeredProfileNames: string[];
	registeredProfileSummary: string;
	profileHint: string;
	/** Blocking-branch wording: roster with descriptions, notes the list is a startup snapshot. */
	availableAgentsSentence: string;
	/** herdr-branch wording: same roster, terser sentence. */
	herdrAgentsSentence: string;
	agentParamHint: string;
}

export function buildAdvertContext(): ToolAdvert {
```

`src/advert.ts:52-99` — the exact template strings that land in the tool description/param hints:

```ts
	// Bake the agents that exist at load time into the tool description and the top-level
	// `agent` hint, so the model has legal names to copy instead of inventing them and can
	// route by role instead of by name. Scope "both" and the launch directory: extensions
	// load once per process, so this is the best available guess at the project set.
	//
	// Two renderings of the one discovery:
	//   - the roster (name + description) goes in the tool description, where routing happens;
	//   - names alone go in the `agent` param hint, which only has to offer legal values to
	//     copy — repeating the prose there would be a second copy of the same tokens.
	// Both come from the same list, so the two surfaces can never advertise different
	// agents, and both keep the same project-first truncation order.
	//
	// Three ways this load-time list can be wrong, all self-healing in one round-trip: a
	// name is missing (agents created after startup), a name is stale (a removed agent is
	// still advertised), or the list is empty (launching from a parent directory finds no
	// project agents at all). The authoritative set is always the per-call
	// discoverAgents(ctx.cwd, agentScope) in execute(), and run.ts answers an unknown
	// name with the full current list.
	const advertAgents = discoverAgents(process.cwd(), "both").agents;
	const rosterAdvert = formatAgentRoster(advertAgents, MAX_LISTED_AGENTS, MAX_AGENT_DESC_CHARS);
	const namesAdvert = formatAgentNames(advertAgents, MAX_LISTED_AGENTS);
	// `+K more` is appended per surface from its own `remaining`; the counts match
	// because the cap and ordering are shared.
	const agentRosterText =
		rosterAdvert.remaining > 0 ? `${rosterAdvert.text} +${rosterAdvert.remaining} more` : rosterAdvert.text;
	const agentNamesText =
		namesAdvert.remaining > 0 ? `${namesAdvert.text} +${namesAdvert.remaining} more` : namesAdvert.text;
	const hasAgentNames = namesAdvert.text.length > 0;
	const availableAgentsSentence = hasAgentNames
		? `Available agents, with what each is for: ${agentRosterText}. Captured at startup from the launch directory, so project-local agents added since then are missing. Passing an unknown name returns the full current list.`
		: `Available agents: none found at startup; project-local agents in ${CONFIG_DIR_NAME}/agents may still exist. Passing an unknown name returns the full current list.`;
	const agentParamHint = hasAgentNames
		? `Name of the agent to invoke (for single mode; the same names apply to items in tasks). Valid: ${agentNamesText}. Passing an unknown name returns the current list.`
		: `Name of the agent to invoke (for single mode; the same names apply to items in tasks). No agents were found at startup; passing any name returns the current list.`;
	// Same roster, herdr wording: it drops the "captured at startup" clause because
	// the fire-and-forget description is already long. Both sentences are derived from
	// the same discovery above, so they always list the same agents.
	const herdrAgentsSentence = agentRosterText
		? `Available agents, with what each is for: ${agentRosterText}. Passing an unknown name returns the full current list.`
		: `No agents found at startup; project-local agents in ${CONFIG_DIR_NAME}/agents may still exist. Passing any name returns the current list.`;

	return {
		registeredProfileNames,
		registeredProfileSummary,
		profileHint,
		availableAgentsSentence,
		herdrAgentsSentence,
		agentParamHint,
	};
}
```

Profile advert strings, `src/advert.ts:37-50`:

```ts
	const globalSettingsPath = path.join(getAgentDir(), "settings.json");
	const profilesEnabled = isProfilesEnabled(globalSettingsPath);
	const registeredGlobalProfiles = profilesEnabled ? loadProfilesFrom(globalSettingsPath) : {};
	const registeredProfileNames = Object.keys(registeredGlobalProfiles);
	// formatProfileSummary always leads with the built-in "current" profile, so the
	// advertised list is never empty even with no custom profiles defined.
	const registeredProfileSummary = formatProfileSummary(registeredGlobalProfiles);
	const profileHint =
		registeredProfileNames.length === 0
			? `Compulsory. The built-in "current" (this session's current model+thinking) is the only profile defined so far; project-level .pi/settings.json may add more.`
			: `Compulsory. Currently available profile(s): ${registeredProfileSummary}. Pick one by name; also check project-level .pi/settings.json for any additional/overriding profiles.`;
```

### Roster/name renderers — `src/agents.ts:162-248`

```ts
/**
 * Rank used to order names in prompt text: project agents first, then user agents.
 * The advertised list is capped by `MAX_LISTED_AGENTS` and truncated from the tail, so
 * the repo-specific names are the ones guaranteed a slot.
 */
const SOURCE_RANK: Record<AgentConfig["source"], number> = { project: 0, user: 1 };

function selectAdvertisedAgents(
	agents: AgentConfig[],
	maxItems: number,
): { listed: AgentConfig[]; remaining: number } {
	const sorted = [...agents].sort((a, b) => {
		const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
		return bySource !== 0 ? bySource : a.name.localeCompare(b.name);
	});
	const listed = sorted.slice(0, Math.max(0, maxItems));
	return { listed, remaining: sorted.length - listed.length };
}

export function formatAgentNames(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	const { listed, remaining } = selectAdvertisedAgents(agents, maxItems);
	return {
		text: listed.map((a) => `${a.name} (${a.source})`).join(", "),
		remaining,
	};
}

function clampDescription(description: string, maxChars: number): string {
	const oneLine = description.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxChars) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function formatAgentRoster(
	agents: AgentConfig[],
	maxItems: number,
	maxDescChars: number,
): { text: string; remaining: number } {
	const { listed, remaining } = selectAdvertisedAgents(agents, maxItems);
	return {
		text: listed
			.map((a) => {
				const head = `${a.name} (${a.source})`;
				const desc = clampDescription(a.description ?? "", maxDescChars);
				return desc ? `${head} — ${desc}` : head;
			})
				.join("; "),
			remaining,
	};
}
```

Entry format: `name (source) — description`, joined by `"; "`, desc clamped to `MAX_AGENT_DESC_CHARS` (120) with `…`, cap `MAX_LISTED_AGENTS` (12) then ` +K more`. Names-only list: `name (source)` joined by `", "`.

---

## 3. PROFILES — `src/profiles.ts` (186 lines)

**Config source: `settings.json`, key `subagent.profiles`, gated by `subagent.enableProfiles === true`.**

`src/profiles.ts:6-49` (verbatim):

```ts
export interface SubagentProfile {
  model?: string;
  thinking?: ThinkingLevel;
}

const VALID_THINKING: ReadonlySet<string> = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

/**
 * Built-in profile name: run the subagent with the parent session's *current*
 * model and thinking level (pinned at spawn time, overriding the agent
 * definition's own model). Always valid, even when custom profiles are
 * disabled; a user-defined profile named "current" takes precedence over the
 * built-in.
 */
export const CURRENT_PROFILE = "current";

function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && VALID_THINKING.has(v);
}

export function isProfilesEnabled(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      subagent?: { enableProfiles?: unknown };
    };
    return raw?.subagent?.enableProfiles === true;
  } catch {
    return false;
  }
}

function parseProfile(raw: unknown): SubagentProfile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.thinking !== undefined && !isThinkingLevel(r.thinking)) return undefined; // unusable
  const out: SubagentProfile = {};
  if (typeof r.model === "string") out.model = r.model;
  if (r.thinking !== undefined) out.thinking = r.thinking;
  return out.model !== undefined || out.thinking !== undefined ? out : undefined;
}

export function loadProfilesFrom(file: string): Record<string, SubagentProfile> {
  if (!fs.existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
  const profiles = (raw as { subagent?: { profiles?: unknown } } | null)?.subagent?.profiles;
  if (typeof profiles !== "object" || profiles === null) return {};
  const out = Object.create(null) as Record<string, SubagentProfile>;
  for (const [name, def] of Object.entries(profiles as Record<string, unknown>)) {
    const p = parseProfile(def);
    if (p) out[name] = p;
  }
  return out;
}
```

`src/profiles.ts:66-105` — summary + load (global then project, project overrides; project only when trusted):

```ts
/**
 * Render the available profiles as a compact human-readable list so the LLM
 * can pick one by name without reading settings.json. The built-in "current"
 * profile is always listed first.
 *
 * e.g. "current (model+thinking = this session's current values), low (model=anthropic/claude-3.5-haiku, thinking=off), high (thinking=medium)"
 */
export function formatProfileSummary(profiles: Record<string, SubagentProfile>): string {
  const render = (n: string): string => {
    const p = profiles[n];
    const parts: string[] = [];
    if (p.model) parts.push(`model=${p.model}`);
    if (p.thinking) parts.push(`thinking=${p.thinking}`);
    return parts.length ? `${n} (${parts.join(", ")})` : n;
  };
  const builtin = `current (model+thinking = this session's current values)`;
  // A user-defined "current" replaces the built-in description line entirely.
  if (Object.hasOwn(profiles, CURRENT_PROFILE)) {
    return Object.keys(profiles).map(render).join(", ");
  }
  const custom = Object.keys(profiles).map(render).join(", ");
  return custom ? `${builtin}, ${custom}` : builtin;
}

export function loadProfiles(cwd: string, projectTrusted: boolean): Record<string, SubagentProfile> {
  const global = loadProfilesFrom(path.join(getAgentDir(), "settings.json"));
  if (!projectTrusted) return global;
  const project = loadProfilesFrom(path.join(cwd, CONFIG_DIR_NAME, "settings.json"));
  return { ...global, ...project };
}

export function loadProfilesIfEnabled(
  cwd: string,
  projectTrusted: boolean,
  enabled: boolean = isProfilesEnabled(path.join(getAgentDir(), "settings.json")),
): Record<string, SubagentProfile> {
  return enabled ? loadProfiles(cwd, projectTrusted) : {};
}
```

`src/profiles.ts:107-186` — validation, lookup, built-in `current`, error message:

```ts
export function validateProfiles(
  requested: (string | undefined)[],
  available: Record<string, SubagentProfile>,
): string[] {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const name of requested) {
    if (name === undefined) continue;
    const key = name.trim();
    if (key === "") continue; // caught by the compulsory-profile check
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === CURRENT_PROFILE) continue; // built-in, always valid
    if (!Object.hasOwn(available, key)) invalid.push(key);
  }
  return invalid;
}

/**
 * Look up a requested profile by name. The built-in "current" profile is not
 * stored in the map; it resolves to the parent session's live model+thinking
 * (which then wins over any agent-definition model in resolveProfile). A
 * user-defined profile named "current" overrides the built-in.
 */
export function lookupProfile(
  profileName: string | undefined,
  profiles: Record<string, SubagentProfile>,
  parent: DispatchDefaults,
): SubagentProfile | undefined {
  if (profileName === undefined) return undefined;
  const key = profileName.trim();
  if (key === "") return undefined;
  if (key === CURRENT_PROFILE && !Object.hasOwn(profiles, CURRENT_PROFILE)) {
    const cur: SubagentProfile = {};
    if (parent.model !== undefined) cur.model = parent.model;
    if (parent.thinkingLevel !== undefined) cur.thinking = parent.thinkingLevel;
    return cur;
  }
  // hasOwn guard: defense-in-depth against prototype-chain names if a caller
  // ever skips validateProfiles.
  return Object.hasOwn(profiles, key) ? profiles[key] : undefined;
}

/** Every valid profile name for error/advertising text: built-in "current" first. */
export function availableProfileNames(profiles: Record<string, SubagentProfile>): string[] {
  return Object.hasOwn(profiles, CURRENT_PROFILE)
    ? Object.keys(profiles)
    : [CURRENT_PROFILE, ...Object.keys(profiles)];
}

/**
 * Error text for a missing (or empty) profile parameter. The profile param is
 * compulsory: every spawned subagent must name one explicitly.
 */
export function profileRequiredMessage(profiles: Record<string, SubagentProfile>): string {
  return (
    "The profile parameter is compulsory: every subagent must name an execution profile " +
    `(single mode: top-level "profile"; parallel mode: "profile" on each task). ` +
    `Use "${CURRENT_PROFILE}" to run with this session's current model+thinking, or pick one of: ` +
    `${availableProfileNames(profiles).join(", ")}.`
  );
}

export function resolveProfile(
  profile: SubagentProfile | undefined,
  agent: { model?: string } | undefined,
  parent: DispatchDefaults,
): DispatchDefaults {
  const out: DispatchDefaults = {};
  const model = profile?.model ?? agent?.model ?? parent.model;
  if (model !== undefined) out.model = model;

  if (profile?.thinking) {
    out.thinkingLevel = profile.thinking;
  } else if (!agent?.model && parent.thinkingLevel) {
    out.thinkingLevel = parent.thinkingLevel;
  }
  return out;
}
```

Unknown-profile rejection text (both branches):

- `src/dispatch.ts:110-119`:
  ```ts
  if (invalid.length > 0) {
  	const validNames = availableProfileNames(profiles).join(", ");
  	return {
  		content: [{
  			type: "text",
  			text: `Unknown subagent profile(s): ${invalid.join(", ")}. Available profiles: ${validNames}.`,
  		}],
  ```
- `src/herdr-tools/spawn.ts:305-312`:
  ```ts
  	const invalid = validateProfiles(requestedProfiles, profiles);
  	if (invalid.length > 0) {
  		const validNames = availableProfileNames(profiles).join(", ");
  		return errorResult(
  			`Unknown subagent profile(s): ${invalid.join(", ")}. Available profiles: ${validNames}.`,
  			"unknown profile",
  		);
  	}
  ```

Compulsory-profile runtime gate (`src/dispatch.ts:122-135`):

```ts
	if (hasSingle && !params.profile?.trim()) {
		return {
			content: [{ type: "text", text: profileRequiredMessage(profiles) }],
			details: makeDetails("single")([]),
			isError: true,
		} as AgentToolResult<SubagentDetails>;
	}
	if (hasTasks && params.tasks!.some((t) => !t.profile?.trim())) {
		return {
			content: [{ type: "text", text: profileRequiredMessage(profiles) }],
			details: makeDetails("parallel")([]),
			isError: true,
		} as AgentToolResult<SubagentDetails>;
	}
```

---

## 4. TOOL SCHEMA — `src/tool-schemas.ts` (104 lines, ENTIRE FILE VERBATIM)

```ts
// src/tool-schemas.ts:1-104
// Shared TypeBox schemas for the subagent tools (both activation branches).
//
// AgentScopeSchema is shared verbatim by every tool that discovers agents.
// buildSubagentParamSchemas() is the single source of truth for the two
// `subagent` variants: the legacy blocking tool and the herdr fire-and-forget
// tool register nearly identical parameter graphs, so both are built here.
//
// INVARIANT: every description string below is part of the tool's advertised
// surface (and of the byte-identical-descriptions rule). Changing one changes
// what the model sees — treat these literals as API, not copy.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ToolAdvert } from "./advert.ts";

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both" (user agents plus project agents; project agents win name conflicts). Use "user" or "project" to restrict discovery.',
	default: "both",
});

/** Which `subagent` tool flavor to build parameter schemas for. */
export type ToolVariant = "blocking" | "herdr";

/**
 * Build the `{ taskItem, params }` TypeBox graphs for one tool variant:
 * `taskItem` is one entry of the parallel `tasks` array, `params` is the
 * tool's top-level schema.
 *
 * The two variants differ only in three description wordings (the blocking
 * branch advertises the load-time agent names in its `agent` hint) and in the
 * herdr-only launch overrides (name/model/tools/systemPrompt/interactive).
 * Field order, `.Optional` wrapping and defaults match both registrations
 * exactly.
 *
 * The return type is intentionally inferred: registerTool() derives the
 * execute() params type from the schema (Static<typeof params>), so widening it
 * to a bare TObject here would erase every parameter's type at the call sites.
 */
export function buildSubagentParamSchemas(variant: ToolVariant, advert: ToolAdvert) {
	const herdr = variant === "herdr";

	// Identical in both variants: one entry of the parallel `tasks` array.
	const taskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		profile: Type.String({ description: `Execution profile (model+thinking) for this task; compulsory. ${advert.profileHint}` }),
	});

	const shared = {
		agent: Type.Optional(
			Type.String({
				description: herdr ? "Name of the agent to invoke (single mode)" : advert.agentParamHint,
			}),
		),
		task: Type.Optional(
			Type.String({ description: herdr ? "Task to delegate (single mode)" : "Task to delegate (for single mode)" }),
		),
		tasks: Type.Optional(
			Type.Array(taskItem, {
				description: herdr
					? "Array of {agent, task} for parallel fire-and-forget execution"
					: "Array of {agent, task} for parallel execution",
			}),
		),
		// Compulsory in single mode; declared optional at the schema level because
		// parallel mode carries the profile per task item and must not be forced to
		// pass a meaningless top-level value. Enforced at runtime in both branches.
		profile: Type.Optional(Type.String({ description: `Execution profile for this single task; compulsory in single mode (agent + task). ${advert.profileHint}` })),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	};

	if (!herdr) return { taskItem, params: Type.Object(shared) };

	return {
		taskItem,
		params: Type.Object({
			...shared,
			name: Type.Optional(
				Type.String({ description: "Display name for the subagent (single mode). Default: the agent's name, or 'Subagent'." }),
			),
			model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
			tools: Type.Optional(
				Type.String({
					description:
						"Comma-separated tool names, `*` globs allowed (e.g. read,bash,codegraph_*) (overrides agent default)",
				}),
			),
			systemPrompt: Type.Optional(
				Type.String({ description: "Role instructions appended to the system prompt (used when the agent has no definition body)" }),
			),
			interactive: Type.Optional(
				Type.Boolean({
					description:
						"Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`.",
				}),
			),
		}),
	};
}
```

Key facts for reproduction:

- **No `Static<>` export** here. Params type is *inferred* by `pi.registerTool` (`Static<typeof params>`) — explicitly documented in the doc comment above.
- **The `profile` key is NEVER deleted when profiles are disabled.** There is no schema mutation anywhere (`grep "delete"` finds only Map deletes). Disabling profiles merely yields an empty profile map: only the built-in `current` remains valid, and `advert.profileHint` still advertises "current" as the only profile.
- `profile` description = `` `Execution profile for this single task; compulsory in single mode (agent + task). ${advert.profileHint}` ``; per-task = `` `Execution profile (model+thinking) for this task; compulsory. ${advert.profileHint}` ``.
- `tasks` item schema: `agent: String` (required), `task: String` (required), `cwd?: String`, `profile: String` (**required — no `.Optional`**).

---

## 5. TOOL-PATTERN MATCHING — `src/tool-patterns.ts` (110 lines)

`src/tool-patterns.ts:25-70` — glob semantics verbatim:

```ts
/** True when an entry contains a glob `*` and must be treated as a pattern. */
export function isToolPattern(entry: string): boolean {
	return entry.includes("*");
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `name` satisfies a tool-list entry (exact match, or glob when the entry contains `*`). */
export function toolPatternMatches(name: string, entry: string): boolean {
	if (!isToolPattern(entry)) return name === entry;
	const source = entry.split("*").map(escapeRegExp).join("[\\s\\S]*");
	return new RegExp(`^${source}$`).test(name);
}

/** Split a comma-separated tool-list string into trimmed, non-empty entries. */
export function parseToolEntries(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Expand pattern entries to concrete tool names.
 *
 * Plain entries pass through unchanged; patterns are replaced by the
 * available names they match (available-list order, deduplicated). A pattern
 * matching nothing is kept literal and reported in `unmatched`.
 */
export function expandToolPatterns(
	entries: string[],
	available: string[],
): { expanded: string[]; unmatched: string[] } {
	const expanded: string[] = [];
	const unmatched: string[] = [];
	const seen = new Set<string>();
	const push = (name: string) => {
		if (!seen.has(name)) {
			seen.add(name);
			expanded.push(name);
		}
	};
	for (const entry of entries) {
		if (!isToolPattern(entry)) {
			push(entry);
			continue;
		}
		const matches = available.filter((name) => toolPatternMatches(name, entry));
		if (matches.length === 0) {
			unmatched.push(entry);
			push(entry);
		} else {
			for (const m of matches) push(m);
		}
	}
	return { expanded, unmatched };
}

/** Pattern entries that match none of `available` (plain names are never reported). */
export function unmatchedToolPatterns(entries: string[], available: string[]): string[] {
	return entries.filter(
		(entry) => isToolPattern(entry) && !available.some((name) => toolPatternMatches(name, entry)),
	);
}

export function unmatchedWarningText(pattern: string): string {
	return `warning: tool pattern "${pattern}" matched no available tools; passed through literally`;
}
```

Semantics: case-sensitive, `*` → `[\s\S]*`, anchored `^...$`; entries without `*` are exact matches. Contract comment at `src/tool-patterns.ts:1-22` documents: "No `?`, no character classes, no regex, case-sensitive."

`src/tool-patterns.ts:72-110` — tool-name source:

```ts
// ── parent-side tool-name source ────────────────────────────────────────────
// Set once at extension load to `() => pi.getAllTools().map(t => t.name)`.
// Lazy on purpose: frontmatter is parsed at load time (before all extensions
// have registered their tools), but expansion happens at spawn time, when the
// registry is complete. Unset (tests, odd load orders) yields an empty list,
// which degrades every pattern to literal-plus-warning — never to a crash.

let toolNameSource: (() => string[]) | null = null;

export function setToolNameSource(fn: (() => string[]) | null): void {
	toolNameSource = fn;
}

/** Current configured tool names, or [] when no source is wired. */
export function getToolNames(): string[] {
	try {
		return toolNameSource ? toolNameSource() : [];
	} catch {
		return [];
	}
}
```

---

## 6. STEER MESSAGES — `src/messages.ts` (405 lines)

**A parallel batch is NOT combined into one message.** Steering is per-child: `armWatcher` (`src/herdr-tools/runtime.ts:203-216`) sends one steer per finished subagent:

```ts
// src/herdr-tools/runtime.ts:203-216
		.then((outcome) => {
			runningSubagents.delete(running.id);
			markSubagentInactive(running.id);
			const contextUsage =
				outcome.kind === "cancelled"
					? null
					: consumeContextUsageSidecar(running.sessionFile, running.id);
			const message = buildOutcomeMessage(
				running,
				opts?.mapOutcome ? opts.mapOutcome(outcome) : outcome,
				{ contextUsage, sessionId: opts?.sessionId ?? null },
			);
			if (message) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		})
```

Watcher-error path (`src/herdr-tools/runtime.ts:217-231`):

```ts
		.catch((err: any) => {
			runningSubagents.delete(running.id);
			markSubagentInactive(running.id);
			pi.sendMessage(
				{
					customType: "subagent_result",
					content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
					display: true,
					details: { name: running.name, task: running.task, error: err?.message ?? String(err) },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		})
```

Types + shared fragments (`src/messages.ts:22-66`):

```ts
export interface SubagentSteerMessage {
  customType: "subagent_result" | "subagent_ping";
  content: string;
  display: true;
  details: Record<string, unknown>;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function sessionRef(sessionFile: string | undefined): string {
  return sessionFile ? `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}` : "";
}

function contextUsageLine(usage: ContextUsageSnapshot | null | undefined): string {
  if (usage?.tokens == null || usage.percent == null || usage.contextWindow <= 0) return "";

  const remaining = Math.max(0, usage.contextWindow - usage.tokens);
  return (
    `\n\nContext: ${usage.tokens.toLocaleString("en-US")}/${usage.contextWindow.toLocaleString("en-US")} tokens ` +
    `(${usage.percent}% used, ${remaining.toLocaleString("en-US")} remaining).`
  );
}
```

`paneOutputSection` (`src/messages.ts:80-83`) and the completed/failed presentation (`:85-95`):

```ts
function paneOutputSection(paneOutput: string | null | undefined): string {
  if (paneOutput == null) return "Pane output unavailable (capture failed, timed out, or pane closed).";
  const output = paneOutput.trim();
  return output ? `Pane output (last 20 lines):\n${output}` : "Pane produced no output.";
}

/** Ported: completed/failed presentation with Session:/Resume: block. */
export function resolveResultPresentation(
  result: { exitCode: number; elapsed: number; summary: string; sessionFile?: string },
  name: string,
): string {
  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef(result.sessionFile)}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef(result.sessionFile)}`;
}
```

Outcome → message switch (`src/messages.ts:97-236`, all branches verbatim):

```ts
export function buildOutcomeMessage(
  running: RunningSubagent,
  outcome: SubagentOutcome,
  opts?: {
    now?: () => number;
    contextUsage?: ContextUsageSnapshot | null;
    /** Canonical pi session UUID, resolved once by the caller (see getSessionId). */
    sessionId?: string | null;
  },
): SubagentSteerMessage | null {
  const now = opts?.now ?? Date.now;
  const elapsed = Math.max(0, Math.floor((now() - running.startTime) / 1000));
  const usageSuffix = contextUsageLine(opts?.contextUsage);

  const baseDetails: Record<string, unknown> = {
    name: running.name,
    task: running.task,
    agent: running.agent,
    elapsed,
    sessionFile: running.sessionFile,
    ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    paneId: running.paneId,
    disposition: outcome.kind,
    ...(opts?.contextUsage ? { contextUsage: opts.contextUsage } : {}),
  };

  switch (outcome.kind) {
    case "cancelled":
      return null;

    case "ping":
      return {
        customType: "subagent_ping",
        content:
          `Sub-agent "${outcome.name}" needs help (${formatElapsed(elapsed)}):\n\n` +
          `${outcome.message}${sessionRef(running.sessionFile)}${usageSuffix}`,
        display: true,
        details: { ...baseDetails, name: outcome.name, message: outcome.message },
      };

    case "completed":
      return {
        customType: "subagent_result",
        content:
          resolveResultPresentation(
            { exitCode: 0, elapsed, summary: outcome.summary, sessionFile: running.sessionFile },
            running.name,
          ) + usageSuffix,
        display: true,
        details: { ...baseDetails, exitCode: 0, summary: outcome.summary },
      };

    case "completed-user-exit":
      return {
        customType: "subagent_result",
        content:
          `Sub-agent "${running.name}" exited (session closed by user, no subagent_done) ` +
          `after ${formatElapsed(elapsed)} — last message:\n\n` +
          `${outcome.summary}${sessionRef(running.sessionFile)}${usageSuffix}`,
        display: true,
        details: { ...baseDetails, exitCode: 0, summary: outcome.summary },
      };

    case "launch-failed": {
      const summaryLines = [
        `Pane: ${running.paneId} (herdr)`,
        `Launch script: ${running.launchScriptFile}`,
        "",
        ...(outcome.heldOpen ? ["The pane was left open for post-mortem."] : []),
        "To retry manually, run in that pane (or any shell):",
        `  bash '${running.launchScriptFile}'`,
      ];
      const summary = summaryLines.join("\n");
      const content = [
        `Sub-agent "${running.name}" failed to launch (exit code ${outcome.exitCode}).`,
        "",
        `Pane: ${running.paneId} (herdr)`,
        `Launch script: ${running.launchScriptFile}`,
        "",
        paneOutputSection(outcome.paneOutput),
        "",
        ...(outcome.heldOpen ? ["The pane was left open for post-mortem."] : []),
        "To retry manually, run in that pane (or any shell):",
        `  bash '${running.launchScriptFile}'`,
      ].join("\n");
      return {
        customType: "subagent_result",
        content: content + usageSuffix,
        display: true,
        details: {
          ...baseDetails,
          exitCode: outcome.exitCode,
          error: "launch-failed",
          heldOpen: outcome.heldOpen,
          launchScriptFile: running.launchScriptFile,
          summary,
          paneOutput: outcome.paneOutput,
        },
      };
    }

    case "crashed": {
      const summary = outcome.summary ?? `Sub-agent exited with code ${outcome.exitCode}`;
      return {
        customType: "subagent_result",
        content:
          resolveResultPresentation(
            { exitCode: outcome.exitCode, elapsed, summary, sessionFile: running.sessionFile },
            running.name,
          ) +
          `\n\n${paneOutputSection(outcome.paneOutput)}` +
          usageSuffix,
        display: true,
        details: {
          ...baseDetails,
          exitCode: outcome.exitCode,
          error: "crashed",
          summary: outcome.summary,
          paneOutput: outcome.paneOutput,
        },
      };
    }

    case "pane-killed": {
      const summary = outcome.summary ?? "No assistant output captured.";
      return {
        customType: "subagent_result",
        content:
          `Sub-agent "${running.name}" failed: herdr pane ${running.paneId} was ` +
          `closed before completion (killed externally, no exit recorded) — last message:\n\n` +
          `${summary}${sessionRef(running.sessionFile)}${usageSuffix}`,
        display: true,
        details: { ...baseDetails, error: "pane-killed", summary: outcome.summary },
      };
    }

    case "gap-exit": {
      const summary = outcome.summary ?? "No assistant output captured.";
      return {
        customType: "subagent_result",
        content:
          `Sub-agent "${running.name}" ended while the event stream was down ` +
          `(herdr pane ${running.paneId} is gone; no exit sidecars found) — last message:\n\n` +
          `${summary}${sessionRef(running.sessionFile)}${usageSuffix}`,
        display: true,
        details: {
          ...baseDetails,
          ...(outcome.exitCode != null ? { exitCode: outcome.exitCode } : {}),
          error: "gap-exit",
          summary: outcome.summary,
        },
      };
    }
  }
}
```

**There is NO fenced code block / delimiter around the child result text** in the steer messages — the summary is inserted raw after a `\n\n`. No triple-backtick fence exists anywhere in `src/` (grep for "```" returned nothing in .ts sources). The load-bearing strings are the `customType`s `"subagent_result"` / `"subagent_ping"` (doc comment at `src/messages.ts:1-20`: "The customType strings ... are load-bearing ... do not rename").

Renderers (`renderSubagentResult`, `renderSubagentPing`) at `src/messages.ts:238-405`; `statusText` at `:262-278`:

```ts
function statusText(disposition: string | undefined, exitCode: number): string {
  switch (disposition) {
    case "completed":
      return "completed";
    case "completed-user-exit":
      return "closed by user (no subagent_done)";
    case "launch-failed":
      return `failed to launch (exit ${exitCode})`;
    case "pane-killed":
      return "pane closed externally";
    case "gap-exit":
      return "ended (event-stream gap)";
    default:
      return exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
  }
}
```

---

## 7. TOOL-DESCRIPTION-LEVEL GUIDANCE

### 7a. Herdr (spawn) tool — `src/herdr-tools/spawn.ts:398-437`

```ts
	const agentsSentence = advert.herdrAgentsSentence;

	const profileSentence =
		advert.registeredProfileNames.length > 0
			? `The profile parameter is compulsory (model+thinking overrides): ${advert.registeredProfileSummary}.`
			: `The profile parameter is compulsory: ${advert.registeredProfileSummary}.`;

	const description = [
		"Delegate tasks to specialized subagents running in dedicated herdr panes with isolated context.",
		"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement (one 'spawned <name> (pane <id>)' line per subagent).",
		"When a sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it.",
		"NEVER write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. NEVER call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you.",
		"NEVER fabricate, assume, or summarize results after calling this tool.",
		"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel); the harness will wake you with each result when it is ready.",
		`Modes: single (agent + task) or parallel (tasks array). ${agentsSentence} ${profileSentence}`,
	].join(" ");

	const { params: HerdrSubagentParams } = buildSubagentParamSchemas("herdr", advert);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description,
		promptGuidelines: [
			"subagent is fire-and-forget: it returns immediately with a spawn acknowledgement; results arrive later as steer messages that start a new turn.",
			"Do not poll, sleep, tail logs, or call other tools to check subagent status; do not fabricate results. After spawning, end the turn or do other independent work.",
			`Choose an agent name from the Available agents list rather than inventing one; an unknown name returns the current list. ${profileSentence}`,
		],
		parameters: HerdrSubagentParams,
```

No `promptSnippet` is used anywhere (`grep promptSnippet` → zero hits). Only `promptGuidelines`.

### 7b. Blocking tool — `src/blocking.ts:15-50`

```ts
export function registerBlockingTool(pi: ExtensionAPI, advert: ToolAdvert): void {
	const { registeredProfileNames, registeredProfileSummary, availableAgentsSentence } = advert;
	// Global settings profiles baked at load time (advert inputs), rebuilt as a
	// map so availableProfileNames can list them with the built-in "current" first.
	const registeredProfilesAsMap = (): Record<string, SubagentProfile> => {
		const out: Record<string, SubagentProfile> = {};
		for (const name of registeredProfileNames) out[name] = {};
		return out;
	};

	const { params: SubagentParams } = buildSubagentParamSchemas("blocking", advert);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task) or parallel (tasks array).",
			`Default agent scope is "both" (recommended): user agents from ${path.join(getAgentDir(), "agents")} plus project-local agents from ${CONFIG_DIR_NAME}/agents (project agents win name conflicts).`,
			`Other options is "user" and "project"`,
			availableAgentsSentence,
			`The profile parameter is compulsory — every subagent must name an execution profile (single mode: top-level profile; parallel mode: per task). Profiles: ${registeredProfileSummary}.`,
		].join(" "),
		promptGuidelines: (() => {
			const pick = (() => {
				if (registeredProfileNames.length === 0) {
					return "The profile parameter is compulsory; pass profile 'current' to run a subagent with this session's current model+thinking (project-level .pi/settings.json may define more profiles).";
				}
				return `The profile parameter is compulsory. Available subagent profile(s): ${registeredProfileSummary}. Check and evaluate the task (priority) and pick one by name (${availableProfileNames(registeredProfilesAsMap()).join("/")}); 'current' runs with this session's current model+thinking.`;
			})();
			return [
				pick,
				"Project-level .pi/settings.json may define additional or overriding profiles beyond this global list, so the full set is resolved per-session.",
				"When calling subagent, choose an agent name from its Available agents list rather than inventing one; an unknown name returns the current list.",
			];
		})(),
		parameters: SubagentParams,
```

Fire-and-forget note appended to every herdr spawn tool result — `src/herdr-tools/common.ts:46-50`:

```ts
export const FIRE_AND_FORGET_NOTE =
	"The sub-agent is running in the background. " +
	"Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. " +
	"The results will be delivered to you automatically as a steer message when the sub-agent finishes. " +
	"Until then, move on to other work or tell the user you're waiting.";
```

Unknown-agent error text (`src/run.ts:109-119`; herdr equivalent `src/herdr-tools/spawn.ts:245-253`):

```ts
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
		};
	}
```

```ts
// src/herdr-tools/spawn.ts:245-253
		const agentConfig = agents.find((a) => a.name === request.agent);
		if (!agentConfig) {
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			failed.push({
				agent: request.agent,
				error: `Agent "${request.agent}" not found. Available agents: ${available}.`,
			});
			continue;
		}
```

---

## 8. SHARED TYPES — `src/types.ts` (76 lines, ENTIRE FILE VERBATIM)

```ts
// src/types.ts:1-76
/**
 * Shared types and constants for the subagent tool.
 */

import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope } from "./agents.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
// How many agent names the tool description + `agent` param hint list before
// collapsing to "+K more". Comfortably above the agents shipped in agents/, so a
// normal install lists every name, while a large library cannot grow the prompt.
export const MAX_LISTED_AGENTS = 12;
// How many characters of an agent's frontmatter `description` the advertised
// roster keeps per entry. Descriptions are meant to be one-liners; the cap bounds
// the cost of one that is not (for example a multi-line YAML scalar).
export const MAX_AGENT_DESC_CHARS = 120;
export const COLLAPSED_ITEM_COUNT = 10;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	profile?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Tool-list warnings (e.g. a `*` pattern that matched no tools). */
	warnings?: string[];
}

export interface SubagentDetails {
	mode: "single" | "parallel";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

/**
 * Minimal subset of the extension tool context that the dispatch orchestrator
 * depends on, so it can be exercised without pulling in the full extension
 * context type.
 */
export interface DispatchContext {
	cwd: string;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	hasUI: boolean;
	isProjectTrusted(): boolean;
}
```

---

## 9. RUNTIME STATE + REGISTRATION

### 9a. `src/runtime-state.ts` (35 lines, ENTIRE FILE VERBATIM)

```ts
// src/runtime-state.ts:1-35
// Process-global coordination shared by the orchestrator extension (index.ts)
// and the child completion extension (subagent-done.ts). Both are loaded into
// the same pi process, but as separate extension modules. A Set is used instead
// of a scalar count so stale closures from /reload can only remove their own ids.

const ACTIVE_SUBAGENT_IDS_KEY = Symbol.for("pi-herdr-subagents/active-subagent-ids");

function getActiveSubagentIds(): Set<string> {
  let ids = (globalThis as any)[ACTIVE_SUBAGENT_IDS_KEY] as Set<string> | undefined;
  if (!(ids instanceof Set)) {
    ids = new Set<string>();
    (globalThis as any)[ACTIVE_SUBAGENT_IDS_KEY] = ids;
  }
  return ids;
}

/** Return the number of nested subagents currently watched by this pi process. */
export function getActiveSubagentCount(): number {
  return getActiveSubagentIds().size;
}

/** Mark one nested subagent as active. */
export function markSubagentActive(id: string): void {
  getActiveSubagentIds().add(id);
}

/** Mark one nested subagent as settled or abandoned. */
export function markSubagentInactive(id: string): void {
  getActiveSubagentIds().delete(id);
}

/** Test seam: clear all process-global active-subagent state. */
export function clearActiveSubagents(): void {
  getActiveSubagentIds().clear();
}
```

### 9b. `src/herdr-tools/registration.ts` — session_start readiness + session_shutdown (lines 43-115 verbatim)

```ts
	pi.on("session_start", (_event, ctx) => {
		// Deny patterns are matched at registration against our known candidate
		// names; a pattern matching NOTHING in the full child registry is still
		// worth surfacing (typo, renamed server). session_start is the first
		// point where getAllTools() reflects every extension's tools.
		const unmatchedDeny = unmatchedToolPatterns(
			deniedEntries,
			pi.getAllTools().map((tool) => tool.name),
		);
		if (unmatchedDeny.length > 0) {
			ctx.ui.notify(
				`pi-herdr-subagents: deny-tools pattern(s) matched no tools: ${unmatchedDeny.join(", ")}`,
				"warning",
			);
		}

		// Registry race: pi resolves duplicate tool names first-loaded-wins,
		// silently. If another extension's `subagent` tool won, warn visibly —
		// never fail silently. sourceInfo.path is preferred; when it is
		// unavailable for every same-name tool, degrade to name-based detection
		// (more than one tool with our name ⇒ possible collision).
		const modulePath = getModulePath() ?? "";
		const sameName = pi.getAllTools().filter((tool) => tool.name === "subagent");
		const normalize = (p: string): string => {
			try {
				return realpathSync(p);
			} catch {
				return p;
			}
		};
		const withPaths = sameName.filter((tool) => tool.sourceInfo?.path);
		const foreign = withPaths.find(
			(tool) => normalize(tool.sourceInfo.path) !== normalize(modulePath),
		);
		if (foreign) {
			ctx.ui.notify(
				`pi-herdr-subagents: another extension's "subagent" tool won the registry race ` +
					`(${foreign.sourceInfo.path}). List pi-herdr-subagents BEFORE other subagent providers ` +
					`in your packages to use the herdr-native tools.`,
				"warning",
			);
		} else if (withPaths.length === 0 && sameName.length > 1) {
			ctx.ui.notify(
				`pi-herdr-subagents: ${sameName.length} "subagent" tools are registered and their sources ` +
					`cannot be determined — another extension may have won the registry race.`,
				"warning",
			);
		}

		// Cheap, asynchronous readiness check. Import stays side-effect free; tool
		// execution awaits the same promise so setup failures stop before artifacts
		// or panes are created.
		invalidateCapability();
		void ensureHerdrCapability()
			.then((message) => {
				if (message) {
					ctx.ui.notify(`pi-herdr-subagents: ${message}`, "warning");
				}
			})
			.catch((error: any) => {
				ctx.ui.notify(
					`pi-herdr-subagents: capability check failed: ${error?.message ?? String(error)}`,
					"warning",
				);
			});
	});

	pi.on("session_shutdown", () => {
		for (const running of runningSubagents.values()) {
			running.abortController?.abort();
			markSubagentInactive(running.id);
		}
		runningSubagents.clear();
		closeStreamAndAbort();
	});

	registerSteerRenderers(pi);
}
```

Registration itself (lines 25-41) — the PI_DENY_TOOLS filter that gates which of the four tools get registered:

```ts
export function registerHerdrBranch(pi: ExtensionAPI, advert: ToolAdvert): void {
	const deniedEntries = (process.env.PI_DENY_TOOLS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const shouldRegister = (name: string) => !deniedEntries.some((entry) => toolPatternMatches(name, entry));

	if (shouldRegister("subagent")) registerSubagentTool(pi, advert);
	if (shouldRegister("subagent_resume")) registerResumeTool(pi);
	if (shouldRegister("subagent_interrupt")) registerInterruptTool(pi);
	if (shouldRegister("subagents_list")) registerListTool(pi);
```

---

# CONTRACTS I MUST REPRODUCE

Observable literals that must match byte-for-byte:

**Settings / config**
- Profiles live in `<agentDir>/settings.json` and `<cwd>/.pi/settings.json`, key path `subagent.profiles`; feature gate `subagent.enableProfiles === true` (strict `true`).
- Herdr branch requires env (`isInsideHerdr()`) AND `subagent.herdr` truthy in settings.json; otherwise the blocking tool registers.
- Project settings participate only when `ctx.isProjectTrusted()`; merge order `{ ...global, ...project }`.

**Agent definitions**
- Discovery files: `<nearest ancestor .pi>/agents/*.md` (project) and `<getAgentDir()>/agents/*.md` (user); project wins name collisions in scope `"both"`.
- `parseFrontmatter` (real YAML) on content; `content.startsWith("---")` required for agent-def parsing.
- Malformed YAML or missing `---` → file skipped, never an error.
- `agents.ts` requires BOTH `name` and `description` to be strings or the file is skipped.
- md `body` is the system prompt. Frontmatter keys: `name, description, model, tools, skill|skills, thinking, deny-tools, spawning, auto-exit, interactive, session-mode, cwd, cli, system-prompt, disable-model-invocation`.
- `spawning: false` denies exactly `subagent, subagent_interrupt, subagents_list, subagent_resume`.

**Advert templates (tool description)**
- Roster entry: `` `${a.name} (${a.source}) — ${desc}` ``, joined by `"; "`; desc whitespace-collapsed, capped at 120 chars ending `…`; cap 12 entries + `` ` +K more` ``.
- Names list: `` `${a.name} (${a.source})` ``, joined by `", "`.
- `` `Available agents, with what each is for: ${agentRosterText}. Captured at startup from the launch directory, so project-local agents added since then are missing. Passing an unknown name returns the full current list.` ``
- `` `Available agents: none found at startup; project-local agents in .pi/agents may still exist. Passing an unknown name returns the full current list.` ``
- `` `Available agents, with what each is for: ${agentRosterText}. Passing an unknown name returns the full current list.` `` (herdr)
- `` `No agents found at startup; project-local agents in .pi/agents may still exist. Passing any name returns the current list.` `` (herdr, empty)
- `` `Name of the agent to invoke (for single mode; the same names apply to items in tasks). Valid: ${agentNamesText}. Passing an unknown name returns the current list.` ``
- `` `Name of the agent to invoke (for single mode; the same names apply to items in tasks). No agents were found at startup; passing any name returns the current list.` ``
- profileHint (none): `` `Compulsory. The built-in "current" (this session's current model+thinking) is the only profile defined so far; project-level .pi/settings.json may add more.` ``
- profileHint (some): `` `Compulsory. Currently available profile(s): ${summary}. Pick one by name; also check project-level .pi/settings.json for any additional/overriding profiles.` ``
- Built-in profile line: `` `current (model+thinking = this session's current values)` ``, always first unless a user profile named `current` overrides.

**Profiles**
- Built-in name constant `"current"`; valid thinking levels `off, minimal, low, medium, high, xhigh, max`.
- Unknown profile error: `` `Unknown subagent profile(s): ${invalid.join(", ")}. Available profiles: ${validNames}.` ``
- Compulsory error: `` `The profile parameter is compulsory: every subagent must name an execution profile (single mode: top-level "profile"; parallel mode: "profile" on each task). Use "current" to run with this session's current model+thinking, or pick one of: ${names}.` ``

**Tool schema literals** (all in §4; must match including the `—`/backticks):
- AgentScope: `'Which agent directories to use. Default: "both" (user agents plus project agents; project agents win name conflicts). Use "user" or "project" to restrict discovery.'`, default `"both"`.
- taskItem: agent `"Name of the agent to invoke"`, task `"Task to delegate to the agent"`, cwd `"Working directory for the agent process"`, profile `` `Execution profile (model+thinking) for this task; compulsory. ${profileHint}` ``.
- agent (blocking) `advert.agentParamHint`; (herdr) `"Name of the agent to invoke (single mode)"`.
- task (blocking) `"Task to delegate (for single mode)"`; (herdr) `"Task to delegate (single mode)"`.
- tasks (blocking) `"Array of {agent, task} for parallel execution"`; (herdr) `"Array of {agent, task} for parallel fire-and-forget execution"`.
- profile: `` `Execution profile for this single task; compulsory in single mode (agent + task). ${profileHint}` ``; optional at schema level, enforced at runtime.
- confirmProjectAgents `"Prompt before running project-local agents. Default: true."`, default `true`.
- cwd `"Working directory for the agent process (single mode)"`.
- herdr-only: name `"Display name for the subagent (single mode). Default: the agent's name, or 'Subagent'."`; model `"Model override (overrides agent default)"`; tools `` "Comma-separated tool names, `*` globs allowed (e.g. read,bash,codegraph_*) (overrides agent default)" ``; systemPrompt `"Role instructions appended to the system prompt (used when the agent has no definition body)"`; interactive `"Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`."`.
- `profile` is NEVER deleted from the schema when profiles are disabled.

**Tool patterns**
- Pattern iff contains `*`; `*` → `[\s\S]*`; anchored `^...$`; case-sensitive; no `?`/classes.
- Warning: `` `warning: tool pattern "${pattern}" matched no available tools; passed through literally` ``.
- `setToolNameSource(() => pi.getAllTools().map(t => t.name))`, called at extension load.

**Steer messages (customType is API)**
- `"subagent_result"` / `"subagent_ping"`; sent via `pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" })`.
- Completed: `` `Sub-agent "${name}" completed (${elapsed}).\n\n${summary}${sessionRef}${usageSuffix}` ``.
- Failed: `` `Sub-agent "${name}" failed (exit code ${exitCode}).\n\n${summary}${sessionRef}${usageSuffix}` ``.
- Ping: `` `Sub-agent "${name}" needs help (${elapsed}):\n\n${message}${sessionRef}${usageSuffix}` ``.
- User-exit: `` `Sub-agent "${name}" exited (session closed by user, no subagent_done) after ${elapsed} — last message:\n\n${summary}${sessionRef}${usageSuffix}` ``.
- Pane-killed: `` `Sub-agent "${name}" failed: herdr pane ${paneId} was closed before completion (killed externally, no exit recorded) — last message:\n\n...` ``.
- Gap-exit: `` `Sub-agent "${name}" ended while the event stream was down (herdr pane ${paneId} is gone; no exit sidecars found) — last message:\n\n...` ``.
- Launch-failed heading: `` `Sub-agent "${name}" failed to launch (exit code ${exitCode}).` `` + `Pane: ... (herdr)` + `Launch script: ...` + `To retry manually, run in that pane (or any shell):\n  bash '<file>'`.
- Watcher error: `` `Sub-agent "${name}" error: ${message}` ``.
- sessionRef: `` `\n\nSession: ${file}\nResume: pi --session ${file}` ``.
- Context line: `` `\n\nContext: ${tokens}/${window} tokens (${percent}% used, ${remaining} remaining).` ``.
- `Pane output (last 20 lines):` / `Pane produced no output.` / `Pane output unavailable (capture failed, timed out, or pane closed).`
- `cancelled` → returns `null` (no steer). **No parallel batching: one steer message per child.** No fences/delimiters around child text.
- Renderer statuses: `completed`, `closed by user (no subagent_done)`, `failed to launch (exit N)`, `pane closed externally`, `ended (event-stream gap)`, `failed (exit N)`.

**Other errors**
- Unknown agent (blocking): `` `Unknown agent: "${agentName}". Available agents: ${quoted list}.` ``; herdr: `` `Agent "${agent}". Available agents: ${list with (source)}.` ``.
- Mode error (blocking): `` `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` ``; herdr: `` `Invalid parameters. Provide exactly one mode: single (agent + task) or parallel (tasks array).\nAvailable agents: ${available}` ``.
- Too many tasks: `` `Too many parallel tasks (${n}). Max is ${MAX_PARALLEL_TASKS}.` `` (MAX_PARALLEL_TASKS = 8).
- Herdr spawn ack: one line per child `` `spawned ${name} (pane ${paneId})${profile ? ` [${profile}]` : ""}` ``, failure `` `failed ${agent}: ${error}` ``, joined by `\n` then `\n\n` + FIRE_AND_FORGET_NOTE.

---

## START HERE

`src/advert.ts` first (it is the single load-time source of the tool-description strings, and it drives both branches), then `src/tool-schemas.ts` (the parameter graph) and `src/herdr-tools/spawn.ts:398-437` (the actual `registerTool` call for the herdr tool). For the child-outcome surface, `src/messages.ts` + `src/herdr-tools/runtime.ts:203-231`.

I completed the extraction task and delivered the full **PI-SIDE SURFACE (current HEAD)** report covering all 9 requested areas with verbatim, file:line-tagged code:

1. **Agent definitions** — `parseFrontmatter` (real YAML from pi), exact harvested frontmatter keys, body→system prompt, discovery dirs, error handling (skip-on-malformed), and project-wins precedence on collision.
2. **Discovery + advert** — exact roster/name template strings, caps (12 listed, 120 desc chars, `+K more`), and both branches' sentences.
3. **Profiles** — settings.json key path `subagent.profiles`, `enableProfiles` gate, built-in `current`, project merge + trust gate, and all exact error messages.
4. **Tool schema** — entire `tool-schemas.ts` verbatim, including the dynamically-generated `profile` descriptions and the key finding that the `profile` param is **never deleted** when profiles are disabled.
5. **Tool patterns** — verbatim `*`→`[\s\S]*` anchored, case-sensitive glob, `toolPatternMatches`, `unmatchedToolPatterns`, `setToolNameSource`.
6. **Steer messages** — all outcome branches verbatim, and the explicit finding that **parallel batches are NOT combined** (one steer per child) and there are **no fences/delimiters** around child result text.
7. **Tool descriptions** — the full blocking and herdr `description`/`promptGuidelines` arrays with interpolation points; noted that `promptSnippet` is not used anywhere.
8. **Shared types** — full `types.ts`.
9. **Runtime state + registration** — full `runtime-state.ts` and the `session_start` readiness/race checks plus `session_shutdown` cleanup.

Closed with a **CONTRACTS I MUST REPRODUCE** list of every literal string (templates, headings, error messages, delimiters) that is observable behaviour.