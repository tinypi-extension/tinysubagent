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
const UP = "\u001b[A";
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
async function openScreen(modelRegistry?: unknown): Promise<{
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
		// Absent in most tests on purpose: the screen has to survive a context that
		// carries no registry at all, and the picker has to render an empty list there.
		modelRegistry,
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

/*
 * The model picker. Its rows come from the registry snapshot the command context
 * carries, so a fake registry drives the whole interaction: which model is
 * highlighted and what an Enter writes. Everything is asserted against the file,
 * not the screen — the file is the contract.
 */

/** A config that already has one profile, so its submenu can be opened directly. */
const ONE_PROFILE = '{\n\t"enableProfiles": true,\n\t"profiles": { "fast": {} }\n}\n';

/** The same profile with a model already chosen, so the picker has one to open on. */
const MODEL_SET = '{\n\t"profiles": { "fast": { "model": "oc-openai/glm-5.3-flash" } }\n}\n';

/** Two models from one provider, one from another, one of them nameless. */
function fakeRegistry() {
	return {
		getAvailable: () => [
			{ provider: "oc-openai", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
			{ provider: "oc-openai", id: "deepseek-flash", name: "DeepSeek Flash" },
			{ provider: "cc", id: "shared-id" },
		],
		getProviderDisplayName: (provider: string) => (provider === "oc-openai" ? "OC OpenAI" : provider),
	};
}

/** Row 0 is Scope, row 1 is Enable profiles, row 2 is the profile. */
function openProfile(screen: { send: (data: string) => void }): void {
	screen.send(DOWN);
	screen.send(DOWN);
	screen.send(ENTER);
}

/**
 * The profile's submenu, then the picker behind its `Model` row. The two steps are
 * what the change bought: the model is a row like any other, and Enter on it is what
 * swaps the rows out for the list.
 */
function openModel(screen: { send: (data: string) => void }): void {
	openProfile(screen);
	screen.send(ENTER);
}

/**
 * Esc once per level — the picker, the profile's submenu, the screen. A key more than
 * there are levels is harmless: the promise is already resolved by then.
 */
function escapeAll(screen: { send: (data: string) => void }): void {
	screen.send(ESC);
	screen.send(ESC);
	screen.send(ESC);
}

/** The `model` the file holds, or undefined when the key is not there at all. */
function savedModel(file: string): string | undefined {
	const parsed = JSON.parse(readFileSync(file, "utf8")) as {
		profiles?: Record<string, { model?: string }>;
	};
	return parsed.profiles?.fast?.model;
}

test("the profile's rows show the stored model, and Enter opens the list", async () => {
	await withScratchConfig(async (file, cleanup) => {
		writeFileSync(file, MODEL_SET);
		const screen = await openScreen(fakeRegistry());
		openProfile(screen);

		// The submenu is the profile's fields as a list, the model among them — and the
		// model it shows is the file's own string, not a name looked up somewhere.
		const rows = screen.component().render(80).join("\n");
		assert.match(rows, /Model/);
		assert.match(rows, /oc-openai\/glm-5\.3-flash/);
		assert.match(rows, /Thinking/);
		assert.doesNotMatch(rows, /no model matches/);

		screen.send(ENTER);

		const rendered = screen.component().render(80).join("\n");
		// Inherit is still the first row: the picker adds choices, it does not remove one.
		assert.match(rendered, /\(inherit\)/);
		assert.match(rendered, /glm-5\.3-flash/);
		assert.match(rendered, /GLM 5\.3 Flash · OC OpenAI/);
		// The nameless model falls back to its provider label.
		assert.match(rendered, /shared-id/);
		// The rows are gone while the picker is up, and the hint says which keys work now.
		assert.match(rendered, /↑↓ walk models/);
		assert.doesNotMatch(rendered, /↑↓ pick a row/);

		escapeAll(screen);
		await screen.closed;
		cleanup();
	});
});

test("Esc in the picker writes nothing and puts the rows back", async () => {
	await withScratchConfig(async (file, cleanup) => {
		writeFileSync(file, ONE_PROFILE);
		const screen = await openScreen(fakeRegistry());
		openModel(screen);

		// Walking to a model is not choosing it: the highlighted row is a pick only once
		// Enter says so, and Esc still means "nothing happened".
		screen.send(DOWN);
		screen.send(DOWN);
		screen.send(ESC);

		const rows = screen.component().render(80).join("\n");
		assert.match(rows, /Thinking/);
		assert.doesNotMatch(rows, /↑↓ walk models/);
		assert.equal(readFileSync(file, "utf8"), ONE_PROFILE, "Esc must not write the walked-to model");

		escapeAll(screen);
		await screen.closed;
		cleanup();
	});
});

test("picking (inherit) removes the key rather than writing one", async () => {
	await withScratchConfig(async (file, cleanup) => {
		writeFileSync(file, MODEL_SET);
		const screen = await openScreen(fakeRegistry());
		openModel(screen);

		// The picker opens on the profile's own model, two rows below `(inherit)`.
		screen.send(UP);
		screen.send(UP);
		screen.send(ENTER);

		assert.equal(savedModel(file), undefined);
		assert.doesNotMatch(readFileSync(file, "utf8"), /model/, "the key is removed, not blanked");

		escapeAll(screen);
		await screen.closed;
		cleanup();
	});
});

test("Enter writes the highlighted row, arrows walk the list", async () => {
	await withScratchConfig(async (file, cleanup) => {
		writeFileSync(file, ONE_PROFILE);
		const screen = await openScreen(fakeRegistry());
		openModel(screen);

		// Rows sort by id, so two downs from `(inherit)` land on glm-5.3-flash.
		screen.send(DOWN);
		screen.send(DOWN);
		screen.send(ENTER);

		assert.equal(savedModel(file), "oc-openai/glm-5.3-flash");
		// The cursor comes back to the row the picker belongs to, and that row now shows
		// what was written.
		assert.match(screen.component().render(80).join("\n"), /oc-openai\/glm-5\.3-flash/);

		escapeAll(screen);
		await screen.closed;
		cleanup();
	});
});

test("a stored model the registry does not offer keeps a row of its own", async () => {
	await withScratchConfig(async (file, cleanup) => {
		// A hand-written id, or a provider that is not logged in. The row shows it, and the
		// list has to show it too: with the field gone there is nowhere else it could live,
		// and an Enter on an untouched picker would otherwise drop the value.
		writeFileSync(file, '{\n\t"profiles": { "fast": { "model": "local/llama-3" } }\n}\n');
		const screen = await openScreen(fakeRegistry());
		openModel(screen);

		const rendered = screen.component().render(80).join("\n");
		assert.match(rendered, /local\/llama-3/);
		assert.match(rendered, /not in the model list/);

		// The picker opened on that row, so a reflex Enter writes back what was there.
		screen.send(ENTER);

		assert.equal(savedModel(file), "local/llama-3", "the stored value must survive an untouched picker");

		escapeAll(screen);
		await screen.closed;
		cleanup();
	});
});

test("Enter on an untouched submenu is a no-op, not a cleared model", async () => {
	await withScratchConfig(async (file, cleanup) => {
		writeFileSync(file, ONE_PROFILE);
		const screen = await openScreen(fakeRegistry());
		openModel(screen);

		// The picker opens on the profile's own model, so a reflex Enter writes back the
		// value that is already there — unchanged text, which is how the screen has always
		// behaved for a value the user did not touch. Here there is no model at all, so
		// the row under the cursor is `(inherit)`, and Enter writes the same nothing.
		screen.send(ENTER);

		assert.equal(readFileSync(file, "utf8"), ONE_PROFILE, "Enter alone must not rewrite the file");

		escapeAll(screen);
		await screen.closed;
		cleanup();
	});
});

test("without a registry the picker offers nothing but (inherit) and says so", async () => {
	await withScratchConfig(async (file, cleanup) => {
		writeFileSync(file, ONE_PROFILE);
		const screen = await openScreen();
		openModel(screen);

		const rendered = screen.component().render(80).join("\n");
		// With no models to list there is nothing to walk: the list holds `(inherit)`
		// alone, and the line under it says why it is that short. There is no field to
		// type a model into any more, so a session with no registry can only unset one.
		assert.match(rendered, /↑↓ walk models/);
		assert.match(rendered, /\(inherit\)/);
		assert.match(rendered, /no models available/);
		assert.doesNotMatch(rendered, /no matches/);

		screen.send(ENTER);

		assert.equal(readFileSync(file, "utf8"), ONE_PROFILE, "Enter on (inherit) writes nothing");

		escapeAll(screen);
		await screen.closed;
		cleanup();
	});
});
