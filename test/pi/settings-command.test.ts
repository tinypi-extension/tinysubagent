/**
 * The `/subagent-settings` command wiring.
 *
 * The screen is verified by hand in a real session (see the spec's testing
 * strategy) — what is pinned here is everything about it that does not need a
 * terminal: the command exists under a name pi will actually dispatch, it exists
 * outside herdr too, non-TUI mode notifies once instead of drawing, opening the
 * screen touches no file, and Esc reaches `done()` so `ctx.ui.custom` cannot
 * leave the editor replaced.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tinysubagent from "../../index.ts";

const COMMAND_NAME = "subagent-settings";
const ESC = "\u001b";
const DOWN = "\u001b[B";
const ENTER = "\r";
const HERDR_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const;

interface CapturedCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** A component as `ctx.ui.custom` hands it back: the screen, not a wrapper. */
interface ScreenComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
}

/** The smallest `ExtensionAPI` the factory touches, plus the command registry. */
function stubApi() {
	const commands: { name: string; command: CapturedCommand }[] = [];
	return {
		commands,
		api: {
			on() {},
			registerTool() {},
			registerCommand(name: string, command: CapturedCommand) {
				commands.push({ name, command });
			},
		},
	};
}

/** Outside herdr is the harder case for registration: the tool is gated, the command is not. */
function withoutHerdr(run: () => void): void {
	const saved = HERDR_KEYS.map((key) => [key, process.env[key]] as const);
	for (const key of HERDR_KEYS) delete process.env[key];
	try {
		run();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** A config path inside a temp dir, so nothing here can reach the real `~/.pi`. */
function withScratchConfig(run: (file: string, cleanup: () => void) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "tinysubagent-settings-"));
	const file = join(dir, "tinysubagent.jsonc");
	const saved = process.env.PI_TINYSUBAGENT_CONFIG;
	process.env.PI_TINYSUBAGENT_CONFIG = file;
	return run(file, () => {
		if (saved === undefined) delete process.env.PI_TINYSUBAGENT_CONFIG;
		else process.env.PI_TINYSUBAGENT_CONFIG = saved;
		rmSync(dir, { recursive: true, force: true });
	});
}

/** `Theme` without colours — the screen only ever calls `fg` and `bold`. */
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function command(): CapturedCommand {
	const stub = stubApi();
	withoutHerdr(() => tinysubagent(stub.api as never));
	assert.equal(stub.commands.length, 1);
	const [registered] = stub.commands;
	assert.equal(registered?.name, COMMAND_NAME);
	return registered?.command as CapturedCommand;
}

test("the command is registered under its own name, outside herdr as well", () => {
	const registered = command();
	// `settings` is pi's built-in and is matched first, so it would never fire.
	assert.notEqual(registered.description, undefined);
	assert.equal(typeof registered.handler, "function");
});

test("outside a TUI the command notifies once and opens no screen", async () => {
	const registered = command();
	const notifications: { message: string; level: string }[] = [];
	let opened = 0;
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		mode: "print",
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
			custom() {
				opened++;
				throw new Error("no screen may be opened without a UI");
			},
		},
	};

	await registered.handler("", ctx);

	assert.equal(opened, 0);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0]?.level, "warning");
	assert.match(notifications[0]?.message ?? "", /interactive/);
});

test("opening the screen writes nothing, and Esc reaches done()", async () => {
	await withScratchConfig(async (file, cleanup) => {
		const registered = command();
		let component: ScreenComponent | undefined;
		let doneCalls = 0;
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			mode: "tui",
			ui: {
				notify() {},
				custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => ScreenComponent) {
					return new Promise<void>((resolve) => {
						component = factory(undefined, theme, undefined, () => {
							doneCalls++;
							resolve();
						});
					});
				},
			},
		};

		const closed = registered.handler("", ctx);
		assert.notEqual(component, undefined, "ctx.ui.custom received the screen");
		const rendered = component?.render(80).join("\n") ?? "";
		assert.match(rendered, /tinysubagent settings/);
		assert.match(rendered, /enableProfiles|Enable profiles/);
		// Opening is not an edit: the target is only created by a mutation the user
		// actually confirms.
		assert.equal(existsSync(file), false);

		component?.handleInput?.(ESC);
		await closed;

		assert.equal(doneCalls, 1, "Esc must resolve ctx.ui.custom");
		assert.equal(existsSync(file), false, "Esc wrote nothing");
		cleanup();
	});
});

/** Open a screen over a config file that does not exist yet. */
async function openScreen(): Promise<{
	send: (data: string) => void;
	closed: Promise<void>;
	component: () => ScreenComponent;
}> {
	const registered = command();
	let component: ScreenComponent | undefined;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		ui: {
			notify() {},
			custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => ScreenComponent) {
				return new Promise<void>((resolve) => {
					component = factory(undefined, theme, undefined, resolve);
				});
			},
		},
	};
	const closed = registered.handler("", ctx);
	return {
		send: (data) => component?.handleInput?.(data),
		closed,
		component: () => component as ScreenComponent,
	};
}

test("a first edit of a missing file waits for y, and n creates nothing", async () => {
	await withScratchConfig(async (file, cleanup) => {
		const screen = await openScreen();
		// Row 0 is Scope, row 1 is Enable profiles; cycling it is a mutation like any other.
		screen.send(DOWN);
		screen.send(ENTER);

		assert.equal(existsSync(file), false, "a mutation alone must not create the file");
		assert.match(screen.component().render(80).join("\n"), /y\/n/);

		screen.send("n");
		assert.equal(existsSync(file), false, "declining is not an error and writes nothing");

		screen.send(ENTER);
		screen.send("y");
		assert.equal(readFileSync(file, "utf8"), '{\n  "enableProfiles": true\n}\n');
		// The file exists now, so the header says so and the confirm is not asked again.
		assert.doesNotMatch(screen.component().render(80).join("\n"), /will be created/);

		screen.send(ESC);
		await screen.closed;
		cleanup();
	});
});

test("a file that parses but cannot hold an edit is refused, not thrown", async () => {
	await withScratchConfig(async (file, cleanup) => {
		// Valid JSONC, and uneditable: jsonc-parser's modify() throws when a path's
		// parent is not an object, so one Enter here must still not break the screen.
		writeFileSync(file, "[1, 2]\n");
		const screen = await openScreen();
		screen.send(DOWN);
		screen.send(ENTER);

		const rendered = screen.component().render(80).join("\n");
		assert.match(rendered, /cannot be edited/);
		assert.equal(readFileSync(file, "utf8"), "[1, 2]\n", "the file must be left alone");

		screen.send(ESC);
		await screen.closed;
		cleanup();
	});
});
