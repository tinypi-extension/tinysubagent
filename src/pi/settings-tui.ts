/**
 * The `/subagent-settings` screen: one file, one `SettingsList`, a write per change.
 *
 * The screen is deliberately thin. Which file it edits comes from
 * `settingsTargets`/`defaultTarget` — the same table config resolution reads, so
 * the screen cannot drift from what the extension actually loads — and every edit
 * is a `ConfigDraft` transformation out of `src/config/draft.ts`, which keeps the
 * file's text (and its comments) authoritative. What is left for this module is
 * the part that needs a terminal: rows, submenus, key handling, and the one
 * decision a pure function cannot make — whether a file that does not exist may
 * be created.
 *
 * Two rules shape the interaction:
 *
 * - Every change writes immediately. There is no dirty state and no Save row, so
 *   "did it save?" is always yes and Esc cannot lose work.
 * - Creating a file waits for a `y`. Writing into `~/.pi/agent/`, or adding a
 *   `.pi` directory to a repository, is the only action here whose effect reaches
 *   outside the file the user picked, so it is the only one that asks. The ask is
 *   one boolean on this component rather than `ctx.ui.confirm`: that dialog opens
 *   over the editor, and a component from `ctx.ui.custom` already owns it.
 */

import * as nodePath from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Key,
	SelectList,
	SettingsList,
	Spacer,
	Text,
	matchesKey,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type SettingItem,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";
import {
	JSONC_CONFIG_FILENAME,
	DEFAULT_SYSTEMONE_BASE_URL,
	SYSTEMONE_MODEL,
	defaultTarget,
	settingsTargets,
	type SettingsTarget,
} from "../config/config.ts";
import {
	addProfile,
	deleteProfile,
	draftClassifierModel,
	draftEnableProfiles,
	draftError,
	draftProfile,
	draftProfiles,
	draftSystemOneAPIKey,
	draftSystemOneBaseUrl,
	draftSystemOneModel,
	readDraft,
	renameProfile,
	setClassifierModel,
	setEnableProfiles,
	setModel,
	setSystemOneAPIKey,
	setSystemOneBaseUrl,
	setSystemOneModel,
	setThinking,
	writeDraft,
	type ConfigDraft,
	type DraftError,
} from "../config/draft.ts";
import { classifierChoices, modelChoices, type ModelChoice } from "../config/models.ts";
import { THINKING_LEVELS, isThinkingLevel, type ThinkingLevel } from "../types.ts";

/** Rows the list shows at once. The screen lives in the editor's place, so short. */
const MAX_VISIBLE = 12;

/** Rows the model picker shows at once; it shares the screen with the profile's rows. */
const PICKER_MAX_VISIBLE = 8;

const SCOPE_ROW = "scope";
const ENABLE_ROW = "enable-profiles";
const ADD_ROW = "add-profile";
const CLASSIFIER_ROW = "classifierModel";
const SYSTEMONE_KEY_ROW = "systemone-api-key";
const SYSTEMONE_URL_ROW = "systemone-base-url";
const SYSTEMONE_MODEL_ROW = "systemone-model";

/**
 * One root-object string row. The classifier and the three SystemOne keys are
 * read, shown, and written alike, so a row spells out only what differs: its
 * config key, the draft's own accessors for it, and the `defaultHint` the row
 * says the key falls back to (the API key has no default, so it has none). A row
 * with a bespoke description supplies `describe` instead.
 */
interface RootStringRow {
	id: string;
	label: string;
	/** The config key named in the row's description. */
	key: string;
	get: (draft: ConfigDraft) => string | undefined;
	set: (draft: ConfigDraft, value: string) => ConfigDraft;
	defaultHint?: string;
	/** Replaces the default `<key> in <file>[; defaults to <hint>]` line. */
	describe?: (file: string) => string;
	/** Opens a model list in place of the one-line field. */
	picker?: RootPickerRow;
}

/**
 * The list behind a `picker` row. It carries the two things a text row's `set`
 * cannot say: how the key is removed again, and what the list's two extra rows are
 * called.
 */
interface RootPickerRow {
	/** The list's title line. */
	title: string;
	/** The first row: choosing it removes the key. */
	empty: { label: string; description: string };
	/** Remove the key — `set` is typed for the text rows, which only ever write one. */
	clear: (draft: ConfigDraft) => ConfigDraft;
	/** A trailing row that swaps the list for the one-line field. */
	writeIn?: { label: string; description: string };
}

/** The profile submenu's model row: the one that opens the picker. */
const MODEL_ROW = "model";

/** The key line under the profile's rows. */
const ROWS_HINT = "↑↓ pick a row · Enter opens · Esc closes";

/** The picker's key line: the list is the whole interaction, so nothing is typed. */
const PICKER_HINT = "↑↓ walk models · Enter saves · Esc closes";

/** The write-in row's value: never a model reference, so no pick can collide with it. */
const WRITE_IN = "\u0000type-a-value";

/** Row id of one profile: names are dynamic, so the id carries the name. */
function profileRow(name: string): string {
	return `profile:${name}`;
}

/** What a profile row shows for a field the file does not set. */
const ABSENT = "—";

/** The thinking row's value for "no key in the file", which means inherit. */
const INHERIT = "(inherit)";

/** What `SettingsList` listens for on Enter; used to activate a row by hand. */
const ENTER = "\r";

const HINT = "Enter cycle · Esc close · changes write immediately · reload pi to apply";

/**
 * pi's own `/settings` builds this theme from its internal theme singleton; the
 * screen is handed the live `Theme` instead, so the shape is rebuilt here against
 * that instance. The colour names are the same semantic ones.
 */
function settingsListTheme(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

/**
 * `SelectList`'s theme, rebuilt against the live `Theme` for the same reason as
 * the settings list's. Its no-match line is written for pi's slash-command list
 * ("No matching commands") and this list is never filtered, so it cannot be
 * reached; it is replaced anyway rather than left to say something about commands.
 */
function selectListTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: () => theme.fg("dim", "  no models to pick"),
	};
}

/** One sentence on the status line, naming the file or the offending name. */
function describeDraftError(error: DraftError): string {
	switch (error.kind) {
		case "reserved-name":
			return `"${error.name}" is a built-in profile and cannot be redefined; nothing was written.`;
		case "duplicate-name":
			return `"${error.name}" is already defined in this file; nothing was written.`;
		case "empty-name":
			return "A profile name cannot be empty; nothing was written.";
		case "invalid-thinking":
			return `"${error.value}" is not a thinking level; nothing was written.`;
		case "missing-name":
			return `"${error.name}" is not defined in this file; nothing was written.`;
		case "unparseable":
			return `${error.file} is not valid JSONC (${error.detail}); not writing.`;
		case "invalid-shape":
			// Parseable but uneditable: the file is left exactly as it was.
			return `${error.file} cannot be edited (${error.detail}); nothing was written.`;
	}
}

/** A failed write is reported, not rethrown: the screen stays open either way. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The Scope row's choices: what resolution found, plus the file a missing scope
 * would be created as. `settingsTargets` lists only files that exist (bar the
 * override), so a scope with no file yet is named here from the same directory
 * and filename constants resolution uses — the screen offers a target per scope
 * without inventing a path of its own.
 */
function scopeOptions(cwd: string, agentDir: string): SettingsTarget[] {
	const found = settingsTargets(cwd, agentDir);
	// An override is the only file resolution reads, so there is nothing to switch to.
	if (found.some((target) => target.scope === "override")) return found;
	const byScope = (scope: "project" | "root") => found.find((target) => target.scope === scope);
	return [
		byScope("project") ?? {
			scope: "project",
			file: nodePath.join(cwd, CONFIG_DIR_NAME, JSONC_CONFIG_FILENAME),
			exists: false,
		},
		byScope("root") ?? { scope: "root", file: nodePath.join(agentDir, JSONC_CONFIG_FILENAME), exists: false },
	];
}

/** How a submenu reports back to the list that opened it. */
type SubmenuDone = (selectedValue?: string, options?: { navigateTo?: string }) => void;

/**
 * The slice of the screen a submenu may touch. Submenus build their own
 * `ConfigDraft` mutation and hand it to `commit`, so the write path — validation,
 * the create confirm, the error status — exists in exactly one place.
 */
interface ScreenHost {
	/** The file being edited: row descriptions and messages name it. */
	readonly file: string;
	/** The text every mutation starts from. */
	currentDraft(): ConfigDraft;
	/** Put one sentence on the status line. */
	status(message: string): void;
	/** Validate, ask if the file must be created, then write. */
	commit(next: ConfigDraft, onWritten: (written: boolean) => void): void;
	/** Rebuild the rows, putting the cursor on `id` and reopening it when asked. */
	rebuild(selectId?: string, reopen?: boolean): void;
	/** Refresh one row's value in place — for an edit made from inside its submenu. */
	refresh(id: string, value: string): void;
	/** The models the picker may offer; empty when the registry offers nothing. */
	modelChoices(): readonly ModelChoice[];
}

/**
 * A titled one-line `Input`: how a name is typed for add and rename. Validation
 * belongs to `src/config/draft.ts`, so this only hands the text up.
 */
class NameSubmenu extends Container {
	private readonly input: Input;

	constructor(options: {
		theme: Theme;
		title: string;
		initial: string;
		submit: (value: string) => void;
		done: SubmenuDone;
	}) {
		super();
		this.input = new Input({ prompt: "> " });
		this.input.setValue(options.initial);
		// The field is the point of the submenu, so it starts focused and shows a cursor.
		this.input.focused = true;
		this.input.onSubmit = (value) => options.submit(value.trim());
		this.input.onEscape = () => options.done();
		this.addChild(new Text(options.theme.bold(options.title), 1, 0));
		this.addChild(this.input);
		this.addChild(new Text(options.theme.fg("dim", "Enter to save · Esc to cancel"), 1, 0));
	}

	handleInput(data: string): void {
		// Esc is handled here as well as by `onEscape`, so the submenu closes even
		// when the input's own key handling has already claimed the key.
		if (matchesKey(data, Key.escape)) {
			this.input.onEscape?.();
			return;
		}
		this.input.handleInput(data);
	}
}

/**
 * The model list for one profile, opened from its `Model` row and rendered in that
 * row's place for as long as it is up.
 *
 * The list is the whole interaction: the row's empty entry first, then every model the
 * registry offers, walked with the arrows and saved with Enter. A model the registry
 * does not offer has no row to write it into, so the value the file already holds gets a
 * row of its own — and a row that allows it gets a trailing write-in row, which swaps
 * the list for the one-line field and covers everything else. Nothing is written here:
 * what the user chose goes back through `done`, and the row that owns it does the
 * writing, so the write path — validation, the create confirm, the error status — stays
 * where every other edit already goes through it.
 */
class ModelPicker extends Container {
	private readonly done: SubmenuDone;
	private readonly picker: SelectList;
	private readonly theme: Theme;
	private readonly title: string;
	private readonly current: string;
	private readonly empty: { label: string; description: string };
	private readonly writeIn: { label: string; description: string } | undefined;
	/** The one-line field the write-in row swapped in, for as long as it is up. */
	private field: Component | undefined;
	/** One line when the registry offered nothing, so the short list explains itself. */
	private readonly note: Text;

	constructor(options: {
		theme: Theme;
		title: string;
		/** The row's value: the model as the file has it, or `""` when there is none. */
		current: string;
		choices: readonly ModelChoice[];
		/** The first row: what "no model" is called here, and how it is explained. */
		empty: { label: string; description: string };
		/** A trailing row that swaps the list for a one-line field, when the row allows one. */
		writeIn?: { label: string; description: string };
		done: SubmenuDone;
	}) {
		super();
		const { theme, title, current, choices, empty, writeIn, done } = options;
		this.done = done;
		this.theme = theme;
		this.title = title;
		this.current = current;
		this.empty = empty;
		this.writeIn = writeIn;
		this.picker = this.buildPicker(choices, current === INHERIT ? "" : current);
		this.note = new Text(
			choices.length === 0 ? theme.fg("dim", "  no models available to pick") : "",
			1,
			0,
		);

		this.addChild(new Text(theme.bold(title), 1, 0));
		this.addChild(this.picker);
		this.addChild(this.note);
	}

	handleInput(data: string): void {
		// While the write-in field is up it owns every key, Esc included: the field's own
		// cancel closes the picker, exactly as the list's Esc does.
		if (this.field) {
			this.field.handleInput?.(data);
			return;
		}
		// Esc closes the picker: it replaced the rows and there is nothing under it to
		// step back to, so it is a screen of its own.
		if (matchesKey(data, Key.escape)) {
			this.done();
			return;
		}
		this.picker.handleInput(data);
	}

	/**
	 * The list itself: the row's empty entry first, then every model the registry offers,
	 * sorted by id. `value` is the `provider/id` string the file holds, so the row under
	 * the cursor is always something the file could actually mean. A model the registry
	 * does not offer is appended when it is this row's current value: the list is the only
	 * way to write a model now, so the one value that already exists has to be on it, or
	 * Enter would quietly drop it.
	 */
	private buildPicker(choices: readonly ModelChoice[], model: string): SelectList {
		const items: SelectItem[] = [
			{ value: "", label: this.empty.label, description: this.empty.description },
			...choices.map((choice) => ({
				value: choice.value,
				label: choice.label,
				description: choice.description,
			})),
		];
		if (model !== "" && !choices.some((choice) => choice.value === model)) {
			items.push({ value: model, label: model, description: "not in the model list" });
		}
		// Held by identity, not by value: the sentinel is the row, so a stored model
		// that happened to equal it could still not be mistaken for the write-in row.
		let writeIn: SelectItem | undefined;
		if (this.writeIn) {
			// Last on purpose: it is the escape hatch, not a model to walk past.
			writeIn = {
				value: WRITE_IN,
				label: this.writeIn.label,
				description: this.writeIn.description,
			};
			items.push(writeIn);
		}
		const picker = new SelectList(items, PICKER_MAX_VISIBLE, selectListTheme(this.theme));
		// Opens on the row's own model, so Enter on an untouched picker is a no-op rather
		// than a clear. Every value the row can hold is a row here — the empty entry
		// included — so the cursor always has something to land on.
		const index = items.findIndex((item) => item.value === model);
		picker.setSelectedIndex(index === -1 ? 0 : index);
		picker.onSelect = (item) => {
			if (item === writeIn) this.openWriteIn();
			else this.save(item.value);
		};
		picker.onCancel = () => this.done();
		return picker;
	}

	/**
	 * Swap the list for the one-line field the write-in row promised. The field is the
	 * picker's own child for as long as it is up and reports back through the same `done`
	 * the list does, so the row that owns this picker writes either way.
	 */
	private openWriteIn(): void {
		const field = new NameSubmenu({
			theme: this.theme,
			title: this.title,
			initial: this.current,
			submit: (value) => {
				// A blank submit is not a clear — the first entry is the only way to clear —
				// so it closes the field having written nothing.
				if (value === "") this.done();
				else this.save(value);
			},
			done: () => this.done(),
		});
		this.field = field;
		this.clear();
		this.addChild(field);
	}

	/**
	 * The highlighted row is the answer: the empty entry reports `""` (the row that owns
	 * the picker decides what that means), and Esc reports nothing at all.
	 */
	private save(value: string): void {
		this.done(value);
	}
}

/**
 * One profile's fields as rows: `Model`, `Thinking`, `Rename`, `Delete`. `Model` is a
 * `submenu` row, the same mechanism `Rename` already uses: `SettingsList` renders what
 * the row returns in place of its own rows and hands it every keystroke until it calls
 * `done`, which puts the new value on the row and restores the cursor to it. One extra
 * keypress buys the profile's fields staying visible as a list, with the model — the
 * field most often changed — as just another row.
 *
 * Nothing here reaches for the profile on demand: the row's own `currentValue` is the
 * model, and it is what the picker is built from, so a model can be chosen without this
 * class knowing anything the row does not already show.
 */
class ProfileSubmenu extends Container {
	private readonly host: ScreenHost;
	private readonly theme: Theme;
	private readonly name: string;
	private readonly done: SubmenuDone;
	private readonly list: SettingsList;
	/** The registry's models, handed to the picker; none means nothing to offer. */
	private readonly choices: readonly ModelChoice[];
	/** The line under the rows, which the picker swaps for its own while it is open. */
	private readonly hintLine: Text;
	/** The model as the file has it: the baseline a refused or cancelled change returns to. */
	private model: string;
	/** The thinking value as the file has it; the baseline a refused change goes back to. */
	private thinking: string;

	constructor(options: { theme: Theme; host: ScreenHost; name: string; done: SubmenuDone }) {
		super();
		const { theme, host, name, done } = options;
		this.host = host;
		this.theme = theme;
		this.name = name;
		this.done = done;

		const profile = draftProfile(host.currentDraft(), name);
		this.thinking = profile.thinking ?? INHERIT;
		this.model = profile.model ?? "";
		this.choices = host.modelChoices();
		this.hintLine = new Text(theme.fg("dim", ROWS_HINT), 1, 0);

		this.list = new SettingsList(
			[
				{
					id: MODEL_ROW,
					label: "Model",
					description: `model for "${name}" in ${host.file} — Enter opens the model list`,
					// The stored string, exactly as the file has it, or `(inherit)` for no key.
					currentValue: this.modelValue(),
					// The value goes down with the row, so the picker opens on this profile's own
					// model without this class having to hand the profile over as well.
					submenu: (current, submenuDone) => this.openPicker(current, submenuDone),
				},
				{
					id: "thinking",
					label: "Thinking",
					description: `thinking for "${name}" in ${host.file}`,
					currentValue: this.thinking,
					// Levels come from the type's own list, never a copy that can drift.
					values: [INHERIT, ...THINKING_LEVELS],
				},
				{
					id: "rename",
					label: "Rename",
					description: `rename "${name}" in ${host.file}`,
					currentValue: "",
					submenu: (_current, submenuDone) =>
						new NameSubmenu({
							theme,
							title: `Rename "${name}" to`,
							initial: name,
							submit: (to) => this.rename(to, submenuDone),
							done: () => submenuDone(),
						}),
				},
				{
					id: "delete",
					label: "Delete",
					// Two-step on purpose: Enter cycles no → yes, and only yes deletes.
					description: `Enter switches this to yes and removes "${name}" from ${host.file}`,
					currentValue: "no",
					values: ["no", "yes"],
				},
			],
			3,
			settingsListTheme(theme),
			(id, value) => this.onChange(id, value),
			() => this.done(),
		);

		this.addChild(new Text(theme.bold(`Profile "${name}"`), 1, 0));
		this.addChild(this.list);
		this.addChild(this.hintLine);
	}

	handleInput(data: string): void {
		// The rows are this submenu's only focus: the picker is a screen of its own, and
		// once it is open `SettingsList` forwards every key to it. What is left to do
		// here is the forward itself, plus the Esc that closes this submenu when no
		// submenu of its own is open.
		this.list.handleInput(data);
	}

	/**
	 * Open the picker on the value the row is showing. The hint line is swapped for as
	 * long as it is up, because the keys that work change with what is on screen.
	 */
	private openPicker(current: string, submenuDone: SubmenuDone): ModelPicker {
		this.hintLine.setText(this.theme.fg("dim", PICKER_HINT));
		return new ModelPicker({
			theme: this.theme,
			title: `Model for "${this.name}"`,
			current,
			choices: this.choices,
			empty: { label: INHERIT, description: "this session's model" },
			done: (value) => {
				this.hintLine.setText(this.theme.fg("dim", ROWS_HINT));
				// The empty entry arrives as `""` and Esc as nothing at all; `(inherit)` is
				// this row's own word for "no key", and `undefined` still means "cancel".
				submenuDone(value === "" ? INHERIT : value);
			},
		});
	}

	/** What the row for this profile shows now: model and thinking, `—` when absent. */
	private rowValue(): string {
		return profileValue(draftProfile(this.host.currentDraft(), this.name));
	}

	/**
	 * The model as the row shows it: the file's own string, or `(inherit)` when there is
	 * no key at all. A model the registry does not know is shown exactly as stored — this
	 * row and the picker's extra row for it are the only places the value is read back, so
	 * nothing may prettify it.
	 */
	private modelValue(): string {
		return this.model === "" ? INHERIT : this.model;
	}

	/**
	 * Write the model the picker reported. `(inherit)` is the row's way of saying "no
	 * key", which `setModel` turns into a key removal rather than a null. `SettingsList`
	 * has already put the new value on the row by the time this runs, so a write that does
	 * not happen puts the file's own answer back: the row must never claim more than the
	 * file says.
	 */
	private setModelRow(value: string): void {
		const model = value === INHERIT ? undefined : value;
		const previous = this.modelValue();
		this.host.commit(setModel(this.host.currentDraft(), this.name, model), (written) => {
			if (!written) {
				this.list.updateValue(MODEL_ROW, previous);
				return;
			}
			this.model = model ?? "";
			this.host.refresh(profileRow(this.name), this.rowValue());
		});
	}

	private onChange(id: string, value: string): void {
		if (id === MODEL_ROW) {
			this.setModelRow(value);
			return;
		}
		if (id === "thinking") {
			// `(inherit)` is the row's way of saying "no key", which `setThinking`
			// turns into a key removal rather than a null. Any other value that is not
			// a level is refused the same way.
			const level = value === INHERIT || !isThinkingLevel(value) ? undefined : value;
			const previous = this.thinking;
			this.host.commit(setThinking(this.host.currentDraft(), this.name, level), (written) => {
				if (written) {
					this.thinking = value;
					this.host.refresh(profileRow(this.name), this.rowValue());
					return;
				}
				// The list already shows the new value; put the old one back so the row
				// never claims something the file does not say.
				this.list.updateValue("thinking", previous);
			});
			return;
		}
		if (id === "delete" && value === "yes") {
			this.host.commit(deleteProfile(this.host.currentDraft(), this.name), (written) => {
				if (!written) {
					this.list.updateValue("delete", "no");
					return;
				}
				// The row is about to disappear, so close before it does.
				this.done();
				this.host.rebuild();
			});
		}
	}

	private rename(to: string, submenuDone: SubmenuDone): void {
		if (to === this.name) {
			submenuDone();
			return;
		}
		const result = renameProfile(this.host.currentDraft(), this.name, to);
		if (!result.ok) {
			this.host.status(describeDraftError(result.error));
			return;
		}
		this.host.commit(result.draft, (written) => {
			if (!written) return;
			// Both levels close: the name field, then this profile's own submenu, whose
			// rows are named for a profile that no longer exists.
			submenuDone();
			this.done();
			this.host.rebuild(profileRow(to));
		});
	}
}

/**
 * A mutation held back because writing it would create the target file. `run`
 * applies it after a `y`; `cancel` tells the caller it did not happen.
 */
interface PendingCreate {
	run: () => void;
	cancel: () => void;
}

/** What `createSettingsScreen` needs from the command that opened it. */
export interface SettingsScreenOptions {
	/** The command context: its cwd is where project scope is looked up. */
	ctx: ExtensionContext;
	/** pi's live theme, injected by `ctx.ui.custom`. */
	theme: Theme;
	/** Must run on every exit path, or `ctx.ui.custom` never resolves. */
	done: () => void;
}

/**
 * Build the screen component for `ctx.ui.custom`. The file it opens is the one
 * config resolution reads; nothing is written by opening it.
 */
export function createSettingsScreen(options: SettingsScreenOptions): Component & { dispose(): void } {
	return new SettingsScreen(options);
}

class SettingsScreen extends Container implements ScreenHost {
	private readonly theme: Theme;
	private readonly done: () => void;
	/** Every scope the screen can switch to, in precedence order. */
	private readonly scopes: SettingsTarget[];
	private target: SettingsTarget;
	private draft: ConfigDraft;
	/** The one mutation waiting on a `y`, or null when nothing is pending. */
	private pending: PendingCreate | null = null;
	/** The registry snapshot the profile submenus offer; read once, never refreshed. */
	private readonly models: readonly ModelChoice[];
	/** The registry's classifier models, for the list a `picker` row opens. */
	private readonly classifiers: readonly ModelChoice[];
	private readonly header: Text;
	private readonly statusLine: Text;
	/** The bottom key line, which a picker swaps for its own while it is up. */
	private readonly hintLine: Text;
	private list: SettingsList;

	constructor(options: SettingsScreenOptions) {
		super();
		this.theme = options.theme;
		this.done = options.done;
		this.scopes = scopeOptions(options.ctx.cwd, getAgentDir());
		this.target = defaultTarget(options.ctx.cwd, getAgentDir());
		this.draft = readDraft(this.target.file);
		this.models = modelChoices(options.ctx.modelRegistry);
		this.classifiers = classifierChoices(options.ctx.modelRegistry);
		this.header = new Text("", 1, 0);
		this.statusLine = new Text("", 1, 0);
		this.hintLine = new Text(this.theme.fg("dim", HINT), 1, 0);
		// An unparseable file still opens and still renders; the status line is where
		// it says why nothing can be changed.
		const broken = draftError(this.draft);
		if (broken) this.status(describeDraftError(broken));
		this.list = this.buildList();
		this.rebuild();
	}

	get file(): string {
		return this.target.file;
	}

	currentDraft(): ConfigDraft {
		return this.draft;
	}

	modelChoices(): readonly ModelChoice[] {
		return this.models;
	}

	/** One sentence below the rows; empty clears it. */
	status(message: string): void {
		this.statusLine.setText(message === "" ? "" : this.theme.fg("dim", message));
	}

	refresh(id: string, value: string): void {
		this.list.updateValue(id, value);
	}

	/**
	 * Recreate the rows from the current draft and put the cursor back on
	 * `selectId`. `reopen` activates that row, which is how a freshly added
	 * profile's submenu opens: `SettingsList.activateItem` is private, so the
	 * public way in is `selectItem` followed by the Enter the list listens for.
	 */
	rebuild(selectId?: string, reopen = false): void {
		this.dispose();
		this.header.setText(this.headerText());
		this.list = this.buildList();
		this.addChild(this.header);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(this.statusLine);
		// The picker swaps this line for its own while it is up, so it is kept rather
		// than rebuilt: the submenu has to reach the same instance the screen shows.
		this.hintLine.setText(this.theme.fg("dim", HINT));
		this.addChild(this.hintLine);
		if (selectId) this.list.selectItem(selectId);
		// Only a row that is actually in the list may be activated: `selectItem` is a
		// no-op for an unknown id, and the Enter would then open whatever row the
		// cursor happened to be left on.
		if (selectId && reopen && this.items().some((item) => item.id === selectId)) {
			this.list.handleInput(ENTER);
		}
	}

	/** Drop every child. The TUI calls this when the screen closes; rebuild starts here. */
	dispose(): void {
		this.clear();
	}

	handleInput(data: string): void {
		// The create-confirm owns the keyboard while it is up: nothing else may act
		// on a key, least of all the list, whose Enter would change the very value
		// the user is being asked about.
		if (this.pending) {
			this.answerCreate(data);
			return;
		}
		this.list.handleInput(data);
	}

	commit(next: ConfigDraft, onWritten: (written: boolean) => void): void {
		// Refuse before and after: the file as found, and the text the edit produced.
		// An unparseable file is never repaired and never rewritten.
		const broken = draftError(this.draft) ?? draftError(next);
		if (broken) {
			this.status(describeDraftError(broken));
			onWritten(false);
			return;
		}
		if (!this.target.exists) {
			this.pending = {
				run: () => this.write(next, onWritten),
				cancel: () => onWritten(false),
			};
			this.statusLine.setText(this.theme.fg("accent", `Create ${this.target.file}? y/n`));
			return;
		}
		this.write(next, onWritten);
	}

	private write(next: ConfigDraft, onWritten: (written: boolean) => void): void {
		const previous = this.draft;
		this.draft = next;
		try {
			writeDraft(next);
		} catch (error) {
			// The file on disk is still the old one, so the text in memory has to be
			// too: a later write must not try to "fix" a change that never landed.
			this.draft = previous;
			this.status(`${next.file} could not be written (${errorText(error)}); the file is unchanged.`);
			onWritten(false);
			return;
		}
		// It exists from here on, so the next edit does not ask again — and the scope
		// row and the layering hint are recomputed from the same fact, or the header
		// would go on saying "will be created" for a file the user just wrote.
		this.target = { ...this.target, exists: true };
		const index = this.scopes.findIndex((scope) => scope.file === this.target.file);
		if (index >= 0) this.scopes[index] = { ...this.scopes[index]!, exists: true };
		this.header.setText(this.headerText());
		this.status("");
		onWritten(true);
	}

	/**
	 * `y` applies the pending change; `n` and Esc drop it and leave the screen open
	 * on the same target; anything else is ignored, so a stray arrow key cannot
	 * create a file in the user's home.
	 */
	private answerCreate(data: string): void {
		const pending = this.pending;
		if (!pending) return;
		if (data === "y" || data === "Y") {
			// The write's own status (success clears it, failure names the error) lands
			// on the line the prompt was occupying.
			this.pending = null;
			pending.run();
			return;
		}
		if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
			this.pending = null;
			this.status("");
			pending.cancel();
		}
	}

	private buildList(): SettingsList {
		return new SettingsList(
			this.items(),
			MAX_VISIBLE,
			settingsListTheme(this.theme),
			(id, value) => this.onChange(id, value),
			() => this.done(),
		);
	}

	private items(): SettingItem[] {
		const file = this.target.file;
		const items: SettingItem[] = [
			{
				id: SCOPE_ROW,
				label: "Scope",
				description: this.scopes
					.map((scope) => `${scope.scope} — ${scope.file} (${scope.exists ? "exists" : "will be created"})`)
					.join("\n"),
				currentValue: this.target.scope,
				values: this.scopes.map((scope) => scope.scope),
			},
			{
				id: ENABLE_ROW,
				label: "Enable profiles",
				description: `enableProfiles in ${file}`,
				currentValue: draftEnableProfiles(this.draft) ? "true" : "false",
				values: ["false", "true"],
			},
		];
		for (const name of draftProfiles(this.draft)) {
			items.push({
				id: profileRow(name),
				label: name,
				description: `model and thinking for "${name}" in ${file}`,
				currentValue: profileValue(draftProfile(this.draft, name)),
				submenu: (_current, done) =>
					new ProfileSubmenu({ theme: this.theme, host: this, name, done }),
			});
		}
		const rootStringRows: readonly RootStringRow[] = [
			{
				id: CLASSIFIER_ROW,
				label: "Classifier model",
				key: "classifierModel",
				get: draftClassifierModel,
				set: setClassifierModel,
				describe: (file) => `classifierModel in ${file}; "<provider>/<model-id>"`,
				picker: {
					title: "Classifier model",
					empty: { label: "(none)", description: "no classifier; the systemOne* keys apply" },
					clear: (draft) => setClassifierModel(draft, undefined),
					writeIn: { label: "Type a value…", description: "enter a <provider>/<model-id> by hand" },
				},
			},
			{
				id: SYSTEMONE_KEY_ROW,
				label: "SystemOne API key",
				key: "systemOneAPIKey",
				get: draftSystemOneAPIKey,
				set: setSystemOneAPIKey,
			},
			{
				id: SYSTEMONE_URL_ROW,
				label: "SystemOne base URL",
				key: "systemOneBaseUrl",
				get: draftSystemOneBaseUrl,
				set: setSystemOneBaseUrl,
				// `.href` keeps the trailing slash this row has always rendered.
				defaultHint: new URL(DEFAULT_SYSTEMONE_BASE_URL).href,
			},
			{
				id: SYSTEMONE_MODEL_ROW,
				label: "SystemOne model",
				key: "systemOneModel",
				get: draftSystemOneModel,
				set: setSystemOneModel,
				defaultHint: SYSTEMONE_MODEL,
			},
		];
		for (const row of rootStringRows) {
			const picker = row.picker;
			items.push({
				id: row.id,
				label: row.label,
				description:
					row.describe?.(file) ??
					(row.defaultHint
						? `${row.key} in ${file}; defaults to ${row.defaultHint}`
						: `${row.key} in ${file}`),
				currentValue: row.get(this.draft) ?? "",
				// A `picker` row opens the list; every other root string row keeps the field.
				submenu: picker
					? (current, done) => this.openRowPicker(row, picker, current, done)
					: (current, done) =>
							new NameSubmenu({
								theme: this.theme,
								title: row.label,
								initial: current,
								submit: (value) => this.setRootString(row, value, done),
								done: () => done(),
							}),
			});
		}
		items.push({
			id: ADD_ROW,
			label: "+ Add profile…",
			description: `add a profile to ${file}`,
			currentValue: "",
			submenu: (_current, done) =>
				new NameSubmenu({
					theme: this.theme,
					title: "New profile name",
					initial: "",
					submit: (name) => this.addProfileRow(name, done),
					done: () => done(),
				}),
		});
		return items;
	}

	/**
	 * Insert `{}` and open the new row. The name is validated by `addProfile`
	 * (`current`, duplicates, and blanks are refused) and the write goes through
	 * the same confirm path as every other change.
	 */
	private addProfileRow(name: string, done: SubmenuDone): void {
		const result = addProfile(this.draft, name);
		if (!result.ok) {
			this.status(describeDraftError(result.error));
			return;
		}
		this.commit(result.draft, (written) => {
			// Not written: the status line already says why, and the name field stays
			// up so the user can correct it instead of retyping it.
			if (!written) return;
			// Close the name field, then rebuild around the new row and activate it.
			// `navigateTo` cannot do this: it belongs to the list instance the rebuild
			// replaces, so it would move a cursor on a list that is about to go away.
			done();
			this.rebuild(profileRow(name), true);
		});
	}

	/**
	 * The list behind a `picker` root row: the same picker the profile's `Model` row
	 * opens, with this row's own title, first entry and write-in row. The hint line is
	 * swapped for as long as it is up, because the keys that work change with the screen.
	 */
	private openRowPicker(
		row: RootStringRow,
		picker: RootPickerRow,
		current: string,
		done: SubmenuDone,
	): ModelPicker {
		this.hintLine.setText(this.theme.fg("dim", PICKER_HINT));
		// The key line belongs to this screen, so it goes back only when the submenu
		// really closes: `setRootString` may still stop to ask whether a file that does
		// not exist may be created, and the picker stays on screen for that question.
		const close = this.restoreHint(done);
		return new ModelPicker({
			theme: this.theme,
			title: picker.title,
			current,
			choices: this.classifiers,
			empty: picker.empty,
			writeIn: picker.writeIn,
			done: (value) => {
				// Esc: the picker was closed without a choice, so nothing is written.
				if (value === undefined) {
					close();
					return;
				}
				// The first entry clears: the key is removed, not written as "".
				if (value === "") this.clearRootString(row, picker, close);
				else this.setRootString(row, value, close);
			},
		});
	}

	/** The submenu's own close, with the screen's key line put back first. */
	private restoreHint(done: SubmenuDone): SubmenuDone {
		return (value) => {
			this.hintLine.setText(this.theme.fg("dim", HINT));
			done(value);
		};
	}

	/** Remove the key a `picker` row holds, then put the row back to what the file says. */
	private clearRootString(row: RootStringRow, picker: RootPickerRow, done: SubmenuDone): void {
		this.commit(picker.clear(this.draft), () => this.syncRow(row.id, row.get(this.draft), done));
	}

	/**
	 * Write one root-object string, then put its row back to what the file says —
	 * `get` runs after the write, so a refused one puts the old value back.
	 */
	private setRootString(row: RootStringRow, value: string, done: SubmenuDone): void {
		this.commit(row.set(this.draft, value), () => this.syncRow(row.id, row.get(this.draft), done));
	}

	/**
	 * Put a row back to what the file now says, then close the name field. These
	 * rows write through the host instead of handing a value back to the list, so
	 * `SettingsList` never refreshes them itself: without this the row keeps showing
	 * the value it had when the submenu opened — empty under a key the file already
	 * holds, or the old value under a new one. `draft` is read at call time, so a
	 * refused write puts the old value back rather than the one that was typed.
	 */
	private syncRow(row: string, value: string | undefined, done: SubmenuDone): void {
		this.list.updateValue(row, value ?? "");
		done();
	}

	private onChange(id: string, value: string): void {
		if (id === SCOPE_ROW) {
			this.switchScope(value);
			return;
		}
		if (id === ENABLE_ROW) {
			const next = setEnableProfiles(this.draft, value === "true");
			this.commit(next, (written) => {
				// The list already shows the new value; put the file's own answer back
				// when the write did not happen, so the row cannot lie.
				if (!written) {
					this.list.updateValue(ENABLE_ROW, draftEnableProfiles(this.draft) ? "true" : "false");
				}
			});
		}
	}

	/**
	 * Switch targets: re-read that file, rebuild, and write nothing. Choosing a
	 * scope is navigation — creating the file the user just pointed at is what the
	 * first edit's confirm is for.
	 */
	private switchScope(scope: string): void {
		const next = this.scopes.find((candidate) => candidate.scope === scope);
		if (!next || next.file === this.target.file) return;
		this.target = next;
		this.draft = readDraft(next.file);
		// A half-asked confirm named the old file; it is meaningless here.
		this.pending = null;
		this.status("");
		const broken = draftError(this.draft);
		if (broken) this.status(describeDraftError(broken));
		this.rebuild(SCOPE_ROW);
	}

	private headerText(): string {
		const lines = [
			this.theme.bold("tinysubagent settings"),
			`${this.target.file} · ${this.target.scope} · ${this.target.exists ? "exists" : "will be created"}`,
		];
		// Both files existing is the one case where an edit can look like it wiped
		// something: a new project file layers over the root file, it does not replace it.
		if (this.bothScopesExist()) {
			lines.push(this.theme.fg("dim", "project layers over root — profiles merge by name"));
		}
		return lines.join("\n");
	}

	private bothScopesExist(): boolean {
		const existing = (scope: "project" | "root") =>
			this.scopes.some((candidate) => candidate.scope === scope && candidate.exists);
		return existing("project") && existing("root");
	}
}

/** A profile row's value: model and thinking, `—` for a field the file does not set. */
function profileValue(profile: { model?: string; thinking?: ThinkingLevel }): string {
	return `${profile.model ?? ABSENT} · ${profile.thinking ?? ABSENT}`;
}
