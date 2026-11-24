/**
 * The plain-terminal supervisor: a child as a process, with no pane anywhere.
 *
 * A terminal that no pane host owns has no pane to put a child in, so the child
 * runs as its own detached process group with piped stdio. There is no layout,
 * no resize, no rename and no pane id: the only address a child has here is the
 * id this module hands out, and it means something only to this module.
 *
 * Its output is read continuously from the moment it starts, whether or not
 * anybody listens: the pipe is what the child writes into, and a reader that
 * waits for a subscriber would stall the child. Feeding that text somewhere is
 * someone else's job — {@link output} is the door, and its unsubscribe is the
 * whole lifecycle of a subscription.
 *
 * Nothing here waits for a pane or types into one, so `stop` is a documented
 * no-op: a headless child cannot be steered from outside, and killing it is an
 * interrupt, not a stop.
 */

import { spawn as spawnProcess, type ChildProcess } from "node:child_process";

import { createCapabilityCheck } from "./capability.ts";
import { createHerdrPaneHost } from "./herdr.ts";
import { createRexPaneHost } from "./rex.ts";
import type { CapabilityCheck, OpenRequest, Supervisor, SupervisorHandle } from "./types.ts";

/** How the plain kind starts a child: a shell, one script, piped stdio. */
export interface PlainSpawnOptions {
	cwd: string;
	stdio: ["ignore", "pipe", "pipe"];
	detached: boolean;
}

/** The child-spawn function, injectable so a test never has to launch a child. */
export type SpawnChild = (command: string, args: string[], options: PlainSpawnOptions) => ChildProcess;

export interface PlainSupervisorDeps {
	spawn?: SpawnChild;
}

/** The supervisor a plain terminal gets: a process supervisor, and nothing more. */
export interface PlainSupervisor extends Supervisor {
	readonly kind: "plain";
	/**
	 * Subscribe to a child's stdout as text. Returns the unsubscribe; the text is
	 * dropped when nobody listens. Present on this kind alone.
	 */
	output(child: SupervisorHandle, onText: (chunk: string) => void): () => void;
}

/** One live child, kept only so its handle can be asked about later. */
interface LiveChild {
	proc: ChildProcess;
	listeners: Set<(chunk: string) => void>;
	/** Set by the process exiting, or by the spawn itself failing. */
	finished: boolean;
}

const herdr = createHerdrPaneHost();
const rex = createRexPaneHost();

/** Ids are unique per module, not per supervisor, so two of them cannot collide. */
let counter = 0;

/** The default spawn: node's, typed to the one shape this module asks for. */
function spawnDetached(command: string, args: string[], options: PlainSpawnOptions): ChildProcess {
	return spawnProcess(command, args, options);
}

/**
 * Drop one stdio stream out of the event-loop reference count.
 *
 * The streams a piped child is given are sockets, and sockets have `unref`; the
 * type node gives them does not say so.
 */
function unrefStream(stream: unknown): void {
	const candidate = stream as { unref?: () => void } | null;
	candidate?.unref?.();
}

/**
 * Build a plain-terminal supervisor. Each one owns the children it opened; the
 * same child addressed to another instance is simply not alive there.
 */
export function createPlainSupervisor(deps: PlainSupervisorDeps = {}): PlainSupervisor {
	const spawnChild = deps.spawn ?? spawnDetached;
	const children = new Map<string, LiveChild>();

	const handleOf = (id: string): SupervisorHandle => ({ supervisor, id });

	const supervisor: PlainSupervisor = {
		kind: "plain",

		// A plain terminal is exactly the absence of a detected pane host: if one
		// is detected, its kind wins even when it is not ready yet.
		detectedIn: (env) => !herdr.detectedIn(env) && !rex.detectedIn(env),

		// Nothing to probe: no host owns this terminal, so nothing can be unready.
		createCapability: (): CapabilityCheck => createCapabilityCheck(async () => ({ problem: null, fix: null })),

		open: async (request: OpenRequest) => {
			const id = `plain-${++counter}`;
			const proc = spawnChild("bash", [request.scriptPath], {
				cwd: request.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			const child: LiveChild = { proc, listeners: new Set(), finished: false };
			children.set(id, child);

			const finish = (): void => {
				child.finished = true;
			};
			proc.once("exit", finish);
			proc.once("error", finish);

			// Read both pipes for as long as the child holds them. Whoever wants the
			// text subscribes through `output`; a subscriber that never arrives must
			// not be able to block the child on a full pipe.
			proc.stdout?.setEncoding("utf8");
			proc.stdout?.on("data", (chunk: string) => {
				for (const listener of child.listeners) listener(chunk);
			});
			proc.stderr?.resume();

			// `detached` makes the child a process of its own, in its own group, so it
			// outlives a restart of this one. `unref` — the pipes included — keeps it out
			// of the count that holds this process open: a child nobody is waiting for
			// must not be able to keep the orchestrator alive. Reading is unaffected
			// while this process runs, which is the only time the text is wanted.
			proc.unref();
			unrefStream(proc.stdout);
			unrefStream(proc.stderr);

			return handleOf(id);
		},

		// No record is no live child: a handle this supervisor never handed out, or
		// one it already closed, has nothing left running.
		ended: async (child: SupervisorHandle) => children.get(child.id)?.finished ?? true,

		// A headless child cannot be steered from outside. Ending it early is an
		// interrupt, which is a kill and belongs to its own path, not to this one.
		stop: async () => {},

		close: async (child: SupervisorHandle) => {
			const record = children.get(child.id);
			if (!record) return false;
			record.listeners.clear();
			return children.delete(child.id);
		},

		output: (child: SupervisorHandle, onText: (chunk: string) => void) => {
			const record = children.get(child.id);
			if (!record) return () => {};
			record.listeners.add(onText);
			return () => {
				record.listeners.delete(onText);
			};
		},
	};

	return supervisor;
}
