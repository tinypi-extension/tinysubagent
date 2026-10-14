#!/usr/bin/env node
import { addTrustedWorkspace, removeTrustedWorkspace } from "./agy-trust.ts";

const [action, workspace, marker] = process.argv.slice(2);
if (!workspace || (action !== "add" && action !== "remove")) process.exit(2);
const home = process.env.HOME;
if (!home) process.exit(2);

try {
	if (action === "add") {
		const added = addTrustedWorkspace(home, workspace);
		if (added && marker) {
			const { writeFileSync } = await import("node:fs");
			writeFileSync(marker, "added\n", "utf8");
		}
	} else {
		removeTrustedWorkspace(home, workspace);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
