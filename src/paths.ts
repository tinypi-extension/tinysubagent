/**
 * Where this package lives on disk.
 *
 * This is the only module in the repository that reads `import.meta.url`. It
 * resolves the package root by walking up to the nearest directory containing a
 * `package.json` rather than counting directories, so the paths below stay
 * correct wherever this file — or any of its callers — is relocated.
 *
 * Two values are contractual and must not be computed anywhere else:
 *
 *   - {@link pluginDir} names the `herdr-plugin/` this package ships, so the
 *     link instruction points at a real path whatever the install method
 *     (local checkout, directory install, git clone);
 *   - {@link childExtensionPath} is the `-e` target the launch script hands to
 *     pi, so a wrong path silently loads no child extension at all.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `start` to the nearest directory containing a `package.json`.
 *
 * Terminates at the filesystem root by returning `start` rather than throwing:
 * an unresolvable root is a worse failure than a wrong-but-usable one for the
 * plugin-link prompt, which must not crash while merely reporting a path.
 */
export function findPackageRoot(start: string): string {
	let current = start;
	for (;;) {
		if (existsSync(join(current, "package.json"))) return current;
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

/** The repository root, resolved from this module's own location. */
export const packageRoot: string = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

/** The `src/` directory inside the package root. */
export const srcDir: string = join(packageRoot, "src");

/**
 * The plugin directory this package ships. Resolved from module location so
 * the link instruction names a real path whatever the install method (local
 * checkout, directory install, git clone).
 */
export function pluginDir(): string {
	return join(packageRoot, "herdr-plugin");
}

/**
 * The child-side pi hook, passed as `-e <path>` by the launch script. The tail
 * segment tracks the child entrypoint.
 */
export const childExtensionPath: string = join(srcDir, "children", "child.ts");
