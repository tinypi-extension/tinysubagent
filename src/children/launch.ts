/**
 * Façade over the launch modules: path planning, the shell wrapper and argv,
 * and task markdown. No logic lives here — existing importers of `./launch.ts`
 * keep working unchanged.
 */
export {
	runId, safeName, timestampForArtifacts, timestampForSession, childSessionDirFor,
	buildLaunchPaths, writeLaunchFiles,
	type LaunchPaths, type LaunchPathsInput, type LaunchFile,
} from "./launch-paths.ts";
export {
	shellEscape, DEFAULT_HOLD_OPEN_SECS, buildLaunchScript, buildPiArgv, resolvePiBin,
	resolveLaunchPrefix, type LaunchScriptOptions, type PiArgvOptions,
} from "./launch-script.ts";
export { buildTaskMarkdown } from "./task-markdown.ts";
