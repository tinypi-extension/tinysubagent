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
 * Nothing here waits for a pane or types into one, so `stop` is this kind's
 * interrupt: a headless child cannot be steered from outside, so it is ended by
 * signalling its whole process group — terminate first, kill after a grace —
 * never by closing something, because there is nothing to close.
 *
 * stderr is read for the one thing it is: evidence. A crashed pane used to be
 * read off the screen, so this kind keeps the end of the child's stderr and hands
 * it to whoever classifies the failure — bounded, because a child that loops on
 * errors must not be able to grow a report.
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
	/**
	 * How long a stopped child is given to act on the termination signal before its
	 * group is killed. Present so a test can shorten the grace; production uses
	 * {@link INTERRUPT_GRACE_MS}.
	 */
	graceMs?: number;
}

/**
 * The grace a child gets between the termination signal and the kill signal.
 * Long enough for a child to flush and exit, short enough that an interrupt
 * still returns promptly when it refuses to.
 */
export const INTERRUPT_GRACE_MS = 5_000;

/**
 * How long the group is given to disappear once it has been killed. SIGKILL
 * cannot be caught, so this only covers the kernel tearing the processes down;
 * the bound is what keeps `stop` from waiting on a process that cannot die.
 */
const KILL_SETTLE_MS = 2_000;

/** How often a dying group's liveness is re-read while waiting for it to end. */
const GROUP_POLL_MS = 10;

/** The supervisor a plain terminal gets: a process supervisor, and nothing more. */
export interface PlainSupervisor extends Supervisor {
	readonly kind: "plain";
	/**
	 * Subscribe to a child's stdout as text. Returns the unsubscribe; the text is
	 * dropped when nobody listens. Present on this kind alone.
	 */
	output(child: SupervisorHandle, onText: (chunk: string) => void): () => void;
	/**
	 * The end of a child's stderr as it stands, for a failure report; empty when
	 * the child wrote nothing there. Present on this kind alone.
	 */
	stderr?(child: SupervisorHandle): string;
}

/** One live child, kept only so its handle can be asked about later. */
interface LiveChild {
	proc: ChildProcess;
	listeners: Set<(chunk: string) => void>;
	/** Set by the process exiting, or by the spawn itself failing. */
	finished: boolean;
	stderr: StderrTail;
}

/**
 * How much of a child's stderr is kept for its failure report: the last lines,
 * which is what a human would have read at the bottom of a crashed pane. Bounded
 * because the stream has no end until the child does, and the report can only
 * ever quote a window of it.
 */
const STDERR_TAIL_LINES = 20;

/**
 * One line's worth of characters is kept; past this it is the middle of a stack
 * trace, not a cause. Also what keeps a child that never writes a newline from
 * growing this buffer one megabyte at a time.
 */
const STDERR_LINE_CHARS = 2_000;

/** The bounded end of one child's stderr. */
interface StderrTail {
	/** Completed lines, oldest first. At most {@link STDERR_TAIL_LINES}. */
	lines: string[];
	/** The line still arriving, kept apart so a chunk split mid-line stays one line. */
	partial: string;
}

function clipLine(line: string): string {
	return line.length <= STDERR_LINE_CHARS ? line : `${line.slice(0, STDERR_LINE_CHARS - 1)}…`;
}

/** Add one chunk to the tail, keeping only the end of it. */
function keepStderr(tail: StderrTail, chunk: string): void {
	const parts = `${tail.partial}${chunk}`.split("\n");
	tail.partial = clipLine(parts.pop() ?? "");
	for (const line of parts) tail.lines.push(clipLine(line));
	// Only the end is ever read, so the front ages out as it is replaced.
	if (tail.lines.length > STDERR_TAIL_LINES) tail.lines.splice(0, tail.lines.length - STDERR_TAIL_LINES);
}

/** The tail as text: the last {@link STDERR_TAIL_LINES} of what the child wrote. */
function readStderr(tail: StderrTail): string {
	const lines = tail.partial === "" ? tail.lines : [...tail.lines, tail.partial];
	return lines.slice(-STDERR_TAIL_LINES).join("\n");
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

/** True while any process of the group is still there. */
function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		// ESRCH is the answer wanted: no process is left in the group.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Signal a whole process group, which is how a child's own tool subprocesses are
 * reached: the group id is the leader's pid because the child was spawned
 * `detached`, and the leading minus is what makes this a group signal rather
 * than one process's.
 *
 * A group that has already ended is not an error — it is the outcome.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** Resolve true once no process of the group is left, false when the bound passes. */
async function groupEnded(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (groupAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
	}
	return true;
}

/**
 * End one child by ending its whole group: terminate, then kill after the grace.
 *
 * The wait is on the group rather than the direct child because a child that
 * exits on SIGTERM can still leave a tool subprocess behind; only once no
 * process of the group is left has the work this child started actually
 * stopped. A group that outlasts the grace is killed, and the kill is what makes
 * the second wait short instead of another grace.
 */
async function endGroup(pid: number, graceMs: number): Promise<void> {
	if (!groupAlive(pid)) return;
	signalGroup(pid, "SIGTERM");
	if (await groupEnded(pid, graceMs)) return;
	signalGroup(pid, "SIGKILL");
	await groupEnded(pid, KILL_SETTLE_MS);
}

/**
 * Build a plain-terminal supervisor. Each one owns the children it opened; the
 * same child addressed to another instance is simply not alive there.
 */
export function createPlainSupervisor(deps: PlainSupervisorDeps = {}): PlainSupervisor {
	const spawnChild = deps.spawn ?? spawnDetached;
	const graceMs = deps.graceMs ?? INTERRUPT_GRACE_MS;
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
			const child: LiveChild = { proc, listeners: new Set(), finished: false, stderr: { lines: [], partial: "" } };
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
			// stderr is evidence, not progress: nothing renders it while the child runs,
			// but the end of it is what says why a child that never reported died.
			proc.stderr?.setEncoding("utf8");
			proc.stderr?.on("data", (chunk: string) => keepStderr(child.stderr, chunk));

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

		// A headless child cannot be steered from outside, so an interrupt ends it:
		// its whole process group is terminated, then killed after the grace. Only a
		// child this supervisor opened can be signalled, and a child that has already
		// ended has nothing left to stop. Never rejects — `stop` is documented as
		// silent, and an interrupt must not be blocked by a process that will not die.
		stop: async (child: SupervisorHandle) => {
			const record = children.get(child.id);
			const pid = record?.proc.pid;
			if (!record || record.finished || pid === undefined) return;
			try {
				await endGroup(pid, graceMs);
			} catch {
				// A group this process may not signal is not a failure the batch can act on.
			}
		},

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

		// Read at the moment a failure is classified, so the tail is as complete as
		// the child left it. No record is no evidence: a child this supervisor never
		// opened, or one already released, has nothing to quote.
		stderr: (child: SupervisorHandle) => {
			const record = children.get(child.id);
			return record === undefined ? "" : readStderr(record.stderr);
		},
	};

	return supervisor;
}
