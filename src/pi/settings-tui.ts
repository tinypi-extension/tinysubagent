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
	defaultTarget,
	settingsTargets,
	type SettingsTarget,
} from "../config/config.ts";
import {
	addProfile,
	deleteProfile,
	draftEnableProfiles,
	draftError,
	draftProfile,
	draftProfiles,
	readDraft,
	renameProfile,
	setEnableProfiles,
	setModel,
	setThinking,
	writeDraft,
	type ConfigDraft,
	type DraftError,
} from "../config/draft.ts";
import {
	modelChoices,
	resolveTypedModel,
	type ModelChoice,
	type TypedModel,
} from "../config/models.ts";
import { THINKING_LEVELS, isThinkingLevel, type ThinkingLevel } from "../types.ts";

/** Rows the list shows at once. The screen lives in the editor's place, so short. */
const MAX_VISIBLE = 12;

/** Rows the model picker shows at once; it shares the screen with the profile's rows. */
const PICKER_MAX_VISIBLE = 8;

const SCOPE_ROW = "scope";
const ENABLE_ROW = "enable-profiles";
const ADD_ROW = "add-profile";

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
 * ("No matching commands"), so the text is replaced rather than passed through —
 * and it is the one place the free-text fallback can be explained, right where
 * the user sees that nothing matched.
 */
function selectListTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: () => theme.fg("dim", "  no model matches — Enter writes what you typed"),
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
 * One profile's fields: a model field (and, when the registry offers models, the
 * picker under it) above a small row list (thinking, rename, delete). The field and
 * the list cannot both own the keyboard, so the submenu keeps a focus flag — the
 * field takes keys first, because the submenu opens precisely so a model can be
 * chosen, and Tab moves down to the rows. The arrows belong to the picker when there
 * is one; without one (no registry: see `buildPicker`) ↓ still descends to the rows.
 */
class ProfileSubmenu extends Container {
	private readonly host: ScreenHost;
	private readonly theme: Theme;
	private readonly name: string;
	private readonly done: SubmenuDone;
	private readonly input: Input;
	private readonly list: SettingsList;
	/** The registry's models, and the picker built from them; no models, no picker. */
	private readonly choices: readonly ModelChoice[];
	private readonly picker: SelectList | undefined;
	/** Say what text that matched no row would write; empty while a row matches. */
	private readonly resolution: Text;
	/** The last text handed to the picker, so a cursor key cannot reset its selection. */
	private filterText = "";
	/** Which child owns the keyboard. */
	private focus: "model" | "rows" = "model";
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
		const model = profile.model ?? "";
		this.choices = host.modelChoices();

		this.input = new Input({
			prompt: "model: ",
			placeholder: this.choices.length > 0 ? "filter models" : "inherit",
		});
		this.input.focused = true;
		// The field is deliberately not seeded with the current model: the picker already
		// marks that row, and a seeded field would filter the list down to it before one
		// character was typed. Empty still means "no key at all" — see `saveModel`.
		this.input.onSubmit = (value) => this.saveModel(value);
		this.input.onEscape = () => this.done();
		this.picker = this.buildPicker(theme, model);
		this.resolution = new Text("", 1, 0);

		this.list = new SettingsList(
			[
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
		this.addChild(
			new Text(theme.fg("muted", `model — currently ${model === "" ? "(inherit)" : model}`), 1, 0),
		);
		this.addChild(this.input);
		if (this.picker) this.addChild(this.picker);
		this.addChild(this.resolution);
		this.addChild(this.list);
		this.addChild(new Text(theme.fg("dim", this.hint()), 1, 0));
	}

	handleInput(data: string): void {
		if (this.focus === "model") {
			// Esc in the field closes the whole submenu: there is nothing between the
			// field and the row list to step back to.
			if (matchesKey(data, Key.escape)) {
				this.done();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				this.focusRows();
				return;
			}
			// The arrows belong to the picker when there is one: walking the models is the
			// point of it. Without a picker ↓ keeps its old meaning, the way down to the rows.
			if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
				if (this.picker) {
					this.picker.handleInput(data);
					return;
				}
				if (matchesKey(data, Key.down)) {
					this.focusRows();
					return;
				}
			}
			this.input.handleInput(data);
			this.filterPicker();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.focusModel();
			return;
		}
		// In the rows, the list decides what Esc means: it cancels an open submenu
		// first and only reaches this submenu's own cancel when there is none.
		this.list.handleInput(data);
	}

	/** The one line that says which keys do what, which depends on there being a picker. */
	private hint(): string {
		return this.picker
			? "↑↓ pick a model · Enter saves · typing filters · Tab to the rows · Esc closes"
			: "Tab switches between the model field and the rows · Esc closes";
	}

	/**
	 * The picker: `(inherit)` first, then every model the registry offers, sorted by
	 * id. `value` is the `provider/id` string the file holds — and the same string the
	 * list filters on — so the row under the cursor is always something the file could
	 * actually mean. No models to offer means no picker: the submenu is then the plain
	 * field it was before this existed, which is also what a session with no configured
	 * provider gets.
	 */
	private buildPicker(theme: Theme, model: string): SelectList | undefined {
		if (this.choices.length === 0) return undefined;
		const items: SelectItem[] = [
			{ value: "", label: "(inherit)", description: "this session's model" },
			...this.choices.map((choice) => ({
				value: choice.value,
				label: choice.label,
				description: choice.description,
			})),
		];
		const picker = new SelectList(items, PICKER_MAX_VISIBLE, selectListTheme(theme));
		// Opens on the profile's own model, so Enter on an untouched submenu is a no-op
		// rather than a clear. A model the registry does not know (a hand-written id, a
		// provider that is not logged in) opens on `(inherit)`, which the line above the
		// field names, so what Enter would write is never hidden.
		const index = this.choices.findIndex((choice) => choice.value === model);
		picker.setSelectedIndex(index >= 0 && model !== "" ? index + 1 : 0);
		picker.onSelect = (item) => this.saveModel(item.value);
		return picker;
	}

	/**
	 * Narrow the picker to what the field holds. Skipped when the text has not changed:
	 * `setFilter` resets the selection to the first row, and a left arrow must not move
	 * the cursor off the model the user just walked to.
	 */
	private filterPicker(): void {
		if (!this.picker) return;
		const text = this.input.getValue();
		if (text !== this.filterText) {
			this.filterText = text;
			this.picker.setFilter(text);
		}
		this.showResolution();
	}

	/**
	 * The line under the picker, for text the list has no row for. Without it the
	 * fallback would be invisible: the list says nothing matched, and what an Enter
	 * would write is not shown anywhere until the row is read back. A match keeps the
	 * line empty — the highlighted row is already the answer.
	 */
	private showResolution(): void {
		const typed = this.input.getValue().trim();
		if (typed === "" || (this.picker?.getSelectedItem() ?? null) !== null) {
			this.resolution.setText("");
			return;
		}
		const resolved = resolveTypedModel(this.choices, typed);
		if (resolved.kind === "inherit") {
			this.resolution.setText("");
			return;
		}
		if (resolved.kind === "ambiguous") {
			this.resolution.setText(this.theme.fg("dim", `${resolved.matches.length} models match — keep typing`));
			return;
		}
		this.resolution.setText(this.theme.fg("dim", `Enter writes ${resolved.value}`));
	}

	/**
	 * Write what the field means. Two rules, in order: a highlighted row wins while the
	 * list has a match — the filter is a prefix of `provider/id`, so the text may be a
	 * fragment of several models and the row is the one being looked at — and with no
	 * match the text itself is the value, resolved to `provider/id` when the registry
	 * knows the id and written as typed when it does not. That second half is the
	 * free-text field this replaces, kept as an escape hatch because the registry is not
	 * the whole world. Text that names several models writes nothing and says why.
	 */
	private saveModel(typed: string): void {
		const selected = this.picker?.getSelectedItem() ?? null;
		const resolved: TypedModel = selected
			? { kind: "model", value: selected.value }
			: resolveTypedModel(this.choices, typed);
		if (resolved.kind === "ambiguous") {
			const shown = resolved.matches.slice(0, 3).join(", ");
			const rest = resolved.matches.length > 3 ? `, +${resolved.matches.length - 3} more` : "";
			this.host.status(`"${typed.trim()}" matches ${resolved.matches.length} models (${shown}${rest})`);
			return;
		}
		// An empty value is a key removal, not a null — see `setModel`.
		const model = resolved.kind === "inherit" ? undefined : resolved.value || undefined;
		this.host.commit(setModel(this.host.currentDraft(), this.name, model), (written) => {
			if (written) this.host.refresh(profileRow(this.name), this.rowValue());
			// Saving the model moves on to the rows rather than trapping the
			// keyboard in a field the user is most likely done with.
			this.focusRows();
		});
	}

	/** What the row for this profile shows now: model and thinking, `—` when absent. */
	private rowValue(): string {
		return profileValue(draftProfile(this.host.currentDraft(), this.name));
	}

	private focusRows(): void {
		this.focus = "rows";
		this.input.focused = false;
	}

	private focusModel(): void {
		this.focus = "model";
		this.input.focused = true;
	}

	private onChange(id: string, value: string): void {
		if (id === "thinking") {
			// `(inherit)` is the row's way of saying "no key", which `setThinking`
			// turns into a key removal rather than a null.
			const level = value === INHERIT ? undefined : isThinkingLevel(value) ? value : undefined;
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
	private readonly header: Text;
	private readonly statusLine: Text;
	private list: SettingsList;

	constructor(options: SettingsScreenOptions) {
		super();
		this.theme = options.theme;
		this.done = options.done;
		this.scopes = scopeOptions(options.ctx.cwd, getAgentDir());
		this.target = defaultTarget(options.ctx.cwd, getAgentDir());
		this.draft = readDraft(this.target.file);
		this.models = modelChoices(options.ctx.modelRegistry);
		this.header = new Text("", 1, 0);
		this.statusLine = new Text("", 1, 0);
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
		this.addChild(new Text(this.theme.fg("dim", HINT), 1, 0));
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
