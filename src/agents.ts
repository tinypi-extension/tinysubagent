/**
 * Agent role discovery.
 *
 * Definitions are markdown files with YAML frontmatter, read from two places:
 *
 *   user    ~/.pi/agent/agents/*.md
 *   project <cwd>/.pi/agents/*.md
 *
 * On a name collision the PROJECT definition wins, so a repository can pin its
 * own reviewer/worker without editing the global one.
 *
 * Frontmatter is parsed with pi's own `parseFrontmatter`, so the accepted YAML
 * dialect is exactly the one pi uses for skills and prompts — no second parser,
 * no dependency.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { AgentDef, AgentSource } from "./types.ts";

export function userAgentsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "agents");
}

export function projectAgentsDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "agents");
}

/**
 * `tools` accepts either a comma/whitespace separated string (the documented
 * one-liner, e.g. `tools: bash, read, codegraph_*`) or a YAML list. Both
 * normalise to the same array; an empty result means "no restriction declared".
 */
function normalizeTools(raw: unknown): string[] | undefined {
	let parts: string[];
	if (typeof raw === "string") {
		parts = raw.split(/[,\s]+/);
	} else if (Array.isArray(raw)) {
		parts = raw.filter((entry): entry is string => typeof entry === "string").flatMap((entry) => entry.split(/[,\s]+/));
	} else {
		return undefined;
	}
	const tools = parts.map((part) => part.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export interface AgentLoadResult {
	agents: AgentDef[];
	warnings: string[];
}

/** Read every `*.md` in one directory. Unreadable/malformed entries are skipped with a warning. */
export function loadAgentsFromDir(dir: string, source: AgentSource): AgentLoadResult {
	const agents: AgentDef[] = [];
	const warnings: string[] = [];
	if (!existsSync(dir)) return { agents, warnings };

	let entries: string[];
	try {
		entries = readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { agents, warnings: [`tinysubagent: cannot read ${dir} (${message}).`] };
	}

	for (const entry of entries) {
		const file = path.join(dir, entry);
		const fallbackName = entry.replace(/\.md$/, "");
		let content: string;
		try {
			content = readFileSync(file, "utf-8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`tinysubagent: cannot read ${file} (${message}); skipping.`);
			continue;
		}

		let frontmatter: Record<string, unknown> = {};
		try {
			frontmatter = parseFrontmatter(content).frontmatter ?? {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`tinysubagent: ${file} has invalid frontmatter (${message}); skipping.`);
			continue;
		}

		const rawName = frontmatter.name;
		const name = typeof rawName === "string" && rawName.trim() !== "" ? rawName.trim() : fallbackName;
		const rawDescription = frontmatter.description;
		const description = typeof rawDescription === "string" ? rawDescription.trim() : "";

		if (description === "") {
			warnings.push(`tinysubagent: ${file} has no description; it will be advertised without one.`);
		}

		agents.push({
			name,
			description,
			tools: normalizeTools(frontmatter.tools),
			body: stripFrontmatter(content).trim(),
			source,
			path: file,
		});
	}

	return { agents, warnings };
}

export interface DiscoveredAgents {
	agents: AgentDef[];
	warnings: string[];
	userDir: string;
	projectDir: string;
}

/**
 * Discover agents from both roots. Project entries overwrite user entries of the
 * same name; the returned list is sorted by name so the tool description the
 * model sees is stable across runs.
 */
export function discoverAgents(cwd: string, agentDir: string = getAgentDir()): DiscoveredAgents {
	const userDir = userAgentsDir(agentDir);
	const projectDir = projectAgentsDir(cwd);

	const user = loadAgentsFromDir(userDir, "user");
	const project = loadAgentsFromDir(projectDir, "project");

	const byName = new Map<string, AgentDef>();
	for (const agent of user.agents) byName.set(agent.name, agent);
	for (const agent of project.agents) byName.set(agent.name, agent);

	const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	return {
		agents,
		warnings: [...user.warnings, ...project.warnings],
		userDir,
		projectDir,
	};
}
