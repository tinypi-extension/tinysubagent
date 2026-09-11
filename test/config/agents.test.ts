import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { discoverAgents, loadAgentsFromDir, projectAgentsDir, userAgentsDir } from "../../src/config/agents.ts";

function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "tinysubagent-agents-"));
}

/** Build a cwd whose `.pi/agents` holds the given files. */
function cwdWithProjectAgents(files: Record<string, string>): string {
	const cwd = tempRoot();
	const dir = path.join(cwd, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
	return cwd;
}

function agentDirWith(files: Record<string, string>): string {
	const agentDir = tempRoot();
	const dir = path.join(agentDir, "agents");
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
	return agentDir;
}

/** The `agents/` subdirectory itself — what loadAgentsFromDir expects. */
function agentsDirWith(files: Record<string, string>): string {
	return path.join(agentDirWith(files), "agents");
}

const REVIEWER = `---
name: reviewer
description: Code review specialist for quality and security analysis
tools: bash, read, grep, ls, codegraph_*
---
You are a senior code reviewer. Analyze code for quality, security, and maintainability.
`;

test("a definition's frontmatter and body are both read", () => {
	const dir = agentsDirWith({ "reviewer.md": REVIEWER });
	const { agents, warnings } = loadAgentsFromDir(dir, "user");
	assert.equal(agents.length, 1);
	const agent = agents[0]!;
	assert.equal(agent.name, "reviewer");
	assert.equal(agent.description, "Code review specialist for quality and security analysis");
	assert.deepEqual(agent.tools, ["bash", "read", "grep", "ls", "codegraph_*"]);
	assert.equal(
		agent.body,
		"You are a senior code reviewer. Analyze code for quality, security, and maintainability.",
	);
	assert.equal(agent.source, "user");
	assert.deepEqual(warnings, []);
});

test("the frontmatter is stripped from the body", () => {
	const dir = agentsDirWith({ "a.md": REVIEWER });
	const agent = loadAgentsFromDir(dir, "user").agents[0]!;
	assert.equal(agent.body.includes("---"), false);
	assert.equal(agent.body.includes("description:"), false);
});

test("tools accepts a YAML list as well as a comma-separated string", () => {
	const dir = agentsDirWith({
		"list.md": `---\nname: list\ndescription: d\ntools:\n  - read\n  - grep\n---\nbody\n`,
	});
	assert.deepEqual(loadAgentsFromDir(dir, "user").agents[0]!.tools, ["read", "grep"]);
});

test("whitespace and empty entries in tools are normalised away", () => {
	const dir = agentsDirWith({ "a.md": `---\nname: a\ndescription: d\ntools: " read ,, grep ,  ls "\n---\nbody\n` });
	assert.deepEqual(loadAgentsFromDir(dir, "user").agents[0]!.tools, ["read", "grep", "ls"]);
});

test("a missing tools field means no declared restriction", () => {
	const dir = agentsDirWith({ "a.md": `---\nname: a\ndescription: d\n---\nbody\n` });
	assert.equal(loadAgentsFromDir(dir, "user").agents[0]!.tools, undefined);
});

test("the name falls back to the filename when frontmatter omits it", () => {
	const dir = agentsDirWith({ "fallback-name.md": `---\ndescription: d\n---\nbody\n` });
	assert.equal(loadAgentsFromDir(dir, "user").agents[0]!.name, "fallback-name");
});

test("a missing description is kept as an empty string and warned about", () => {
	const dir = agentsDirWith({ "a.md": `---\nname: a\n---\nbody\n` });
	const { agents, warnings } = loadAgentsFromDir(dir, "user");
	assert.equal(agents[0]!.description, "");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /no description/);
});

test("non-markdown files are ignored", () => {
	const dir = agentsDirWith({ "a.md": REVIEWER, "notes.txt": "ignored", "README": "ignored" });
	const { agents } = loadAgentsFromDir(dir, "user");
	assert.deepEqual(agents.map((a) => a.name), ["reviewer"]);
});

test("a missing directory is an empty result, not an error", () => {
	const { agents, warnings } = loadAgentsFromDir(path.join(tempRoot(), "nope"), "user");
	assert.deepEqual(agents, []);
	assert.deepEqual(warnings, []);
});

test("a file with invalid frontmatter is skipped with a warning, not fatal", () => {
	// pi's YAML parser throws on an unclosed flow sequence; one broken role
	// must not take down discovery of the others.
	const dir = agentsDirWith({ "broken.md": `---\nname: [unclosed\n---\nbody\n`, "ok.md": REVIEWER });
	const { agents, warnings } = loadAgentsFromDir(dir, "user");
	assert.deepEqual(agents.map((a) => a.name), ["reviewer"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /invalid frontmatter/);
});

test("discoverAgents reads both roots and lets the project definition win", () => {
	const agentDir = agentDirWith({
		"reviewer.md": REVIEWER,
		"user-only.md": `---\nname: user-only\ndescription: from user\n---\nuser body\n`,
	});
	const cwd = cwdWithProjectAgents({
		"reviewer.md": `---\nname: reviewer\ndescription: project reviewer\ntools: read\n---\nproject body\n`,
		"project-only.md": `---\nname: project-only\ndescription: from project\n---\nproject body\n`,
	});

	const { agents } = discoverAgents(cwd, agentDir);
	assert.deepEqual(agents.map((a) => a.name), ["project-only", "reviewer", "user-only"]);

	const reviewer = agents.find((a) => a.name === "reviewer")!;
	assert.equal(reviewer.source, "project");
	assert.equal(reviewer.description, "project reviewer");
	assert.deepEqual(reviewer.tools, ["read"]);
	assert.equal(reviewer.body, "project body");

	assert.equal(agents.find((a) => a.name === "user-only")!.source, "user");
	assert.equal(agents.find((a) => a.name === "project-only")!.source, "project");
});

test("discoverAgents is sorted by name so the advertised roster is stable", () => {
	const agentDir = agentDirWith({
		"z.md": `---\nname: zeta\ndescription: d\n---\nb\n`,
		"a.md": `---\nname: alpha\ndescription: d\n---\nb\n`,
		"m.md": `---\nname: mu\ndescription: d\n---\nb\n`,
	});
	assert.deepEqual(discoverAgents(tempRoot(), agentDir).agents.map((a) => a.name), ["alpha", "mu", "zeta"]);
});

test("discoverAgents works with neither root present", () => {
	const { agents, warnings } = discoverAgents(tempRoot(), tempRoot());
	assert.deepEqual(agents, []);
	assert.deepEqual(warnings, []);
});

test("the project agents directory sits under .pi in the cwd", () => {
	assert.equal(projectAgentsDir("/work/repo"), path.join("/work/repo", ".pi", "agents"));
});

test("the user agents directory sits under the agent dir", () => {
	assert.equal(userAgentsDir("/home/u/.pi/agent"), path.join("/home/u/.pi/agent", "agents"));
});
