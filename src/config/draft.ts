/**
 * The document layer behind the settings screen: every edit is a text → text
 * transformation over the raw config file, so comments, key order, and keys the
 * screen does not model survive an edit untouched.
 *
 * The file's text is the source of truth; nothing here re-serialises the config
 * as a whole. `JSON.stringify` would be the one-line way to write a profile, and
 * the one way to destroy the comment the user wrote to remember why the profile
 * exists — so every mutation goes through `jsonc-parser`'s edit machinery, which
 * patches the text at a JSON path instead of reprinting the document.
 *
 * Errors are values, not exceptions, because each one is a status line the user
 * stays in the screen to read. An unparseable file is never modified or written:
 * the screen may still *read* it, but any mutation is refused and the text is
 * kept exactly as it was found.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
// The edit half of jsonc-parser, not just its parse half: `modify` computes the
// minimal text edits for a JSON-path change and `applyEdits` splices them in.
import {
	applyEdits,
	findNodeAtLocation,
	modify,
	parse as parseJsonc,
	parseTree,
	printParseErrorCode,
	type ParseError,
} from "jsonc-parser";
import { CURRENT_PROFILE } from "./config.ts";
import { isThinkingLevel, type ThinkingLevel } from "../types.ts";

/** One config file held open for editing: the path plus its exact raw text. */
export interface ConfigDraft {
	file: string;
	/** Raw file text; `""` when the file does not exist (yet). */
	text: string;
}

export type DraftError =
	| { kind: "reserved-name"; name: string }
	| { kind: "duplicate-name"; name: string }
	| { kind: "empty-name" }
	| { kind: "invalid-thinking"; value: string }
	/** The target file exists but does not parse as JSONC; never written to. */
	| { kind: "unparseable"; file: string; detail: string }
	/**
	 * A rename was asked for a source profile the document does not define. Not in
	 * the spec's union because only rename can produce it: add never looks a name
	 * up, and the other kinds carry no notion of a lookup miss.
	 */
	| { kind: "missing-name"; name: string }
	/**
	 * The text parses but cannot hold this edit: a root that is not an object, a
	 * `profiles` value that is not one, or a profile whose value is not one.
	 * `jsonc-parser`'s `modify` throws on those parents, and a throw would come out
	 * of a keypress — so the shape is checked here and refused as a value.
	 */
	| { kind: "invalid-shape"; file: string; detail: string };

export type DraftResult = { ok: true; draft: ConfigDraft } | { ok: false; error: DraftError };

// Two-space indent is the dialect this file is written in; the formatting options
// only shape text jsonc-parser *inserts*, existing text is left byte-identical.
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/**
 * Parse the text, treating a missing file (empty text) as a valid empty document.
 * jsonc-parser reports errors instead of throwing, and keeps going after the
 * first one — the first is the one worth showing.
 */
function parseDraft(draft: ConfigDraft): { root: unknown; errors: ParseError[] } {
	// Whitespace-only text parses as "no value" with an error, but it is what an
	// editor leaves behind after the user selects-all and deletes — treating it as
	// broken would lock the user out of a file they can still trivially fix.
	if (draft.text.trim() === "") return { root: undefined, errors: [] };
	// Same dialect the loader accepts (comments and trailing commas legal): the
	// screen must not refuse to edit a file that resolution reads happily.
	const errors: ParseError[] = [];
	const root = parseJsonc(draft.text, errors, { allowTrailingComma: true, disallowComments: false });
	return { root, errors };
}

/** The reason this draft's text cannot be edited, or `undefined` when it can. */
export function draftError(draft: ConfigDraft): DraftError | undefined {
	const { root, errors } = parseDraft(draft);
	if (errors.length > 0) {
		const error = errors[0]!;
		return {
			kind: "unparseable",
			file: draft.file,
			// Same wording the config loader uses, so the two surfaces agree on what
			// "broken" means for the same file.
			detail: `${printParseErrorCode(error.error)} at offset ${error.offset}`,
		};
	}
	// A document that parses can still be uneditable: `modify` walks the path and
	// throws when a parent is not an object, which is a file shape the loader reads
	// without complaint (an array root, `profiles` as a string, a profile as `5`).
	// Refusing it here is what keeps that throw from escaping a keypress.
	if (root === undefined) return undefined;
	if (!isObject(root)) {
		return { kind: "invalid-shape", file: draft.file, detail: "the root is not a JSON object" };
	}
	const profiles = root.profiles;
	if (profiles === undefined) return undefined;
	if (!isObject(profiles)) {
		return { kind: "invalid-shape", file: draft.file, detail: "\"profiles\" is not a JSON object" };
	}
	for (const [name, entry] of Object.entries(profiles)) {
		if (!isObject(entry)) {
			return {
				kind: "invalid-shape",
				file: draft.file,
				detail: `"profiles.${name}" is not a JSON object`,
			};
		}
	}
	return undefined;
}

/** A plain object — the only thing `modify` can add a key to. */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the file into a draft. A missing file is the documented default state,
 * not an error — the draft's empty text is what the first edit builds on.
 */
export function readDraft(file: string): ConfigDraft {
	try {
		return { file, text: readFileSync(file, "utf-8") };
	} catch {
		return { file, text: "" };
	}
}

function rootObject(draft: ConfigDraft): Record<string, unknown> | undefined {
	const { root, errors } = parseDraft(draft);
	// Unparseable text contributes nothing, even though jsonc-parser's error
	// recovery hands back a partial AST: a half-read file must not look like a
	// working one, or the screen would show rows for a document it cannot edit.
	if (errors.length > 0) return undefined;
	return isObject(root) ? root : undefined;
}

/** Whether the file switches profiles on. Absent means off, as the loader reads it. */
export function draftEnableProfiles(draft: ConfigDraft): boolean {
	return rootObject(draft)?.enableProfiles === true;
}

/** Profile names in the file, sorted, with the built-in `current` excluded. */
export function draftProfiles(draft: ConfigDraft): string[] {
	const profiles = rootObject(draft)?.profiles;
	if (!isObject(profiles)) return [];
	return Object.keys(profiles)
		.filter((name) => name !== CURRENT_PROFILE)
		.sort();
}

/** One profile's model/thinking as the file states them; absent keys mean inherit. */
export function draftProfile(draft: ConfigDraft, name: string): { model?: string; thinking?: ThinkingLevel } {
	const raw = rootObject(draft)?.profiles;
	const entry = isObject(raw) ? raw[name] : undefined;
	if (!isObject(entry)) return {};
	const profile: { model?: string; thinking?: ThinkingLevel } = {};
	const record = entry;
	if (typeof record.model === "string") profile.model = record.model;
	if (isThinkingLevel(record.thinking)) profile.thinking = record.thinking;
	return profile;
}

/**
 * Splice one JSON-path change into the text, or return the draft unchanged when
 * the file does not parse. Editing unparseable text would mangle it, and the
 * file must never be left worse than it was found.
 */
function applyModify(draft: ConfigDraft, p: (string | number)[], value: unknown): ConfigDraft {
	if (draftError(draft)) return draft;
	try {
		const edits = modify(draft.text, p, value, FORMAT);
		return { ...draft, text: applyEdits(draft.text, edits) };
	} catch {
		// The shape checks in `draftError` name every parent that cannot hold an
		// edit; this keeps any shape they miss from escaping as an exception, which
		// is the one way a keypress could take the screen down.
		return draft;
	}
}

/**
 * Why an `applyModify` call was refused, as a value. `draftError` names the
 * shapes worth showing; the fallback covers the rest, so a caller never has to
 * treat `draftError` as non-`undefined` on the strength of a refusal alone.
 */
function editRefusal(draft: ConfigDraft): DraftError {
	return (
		draftError(draft) ?? {
			kind: "invalid-shape",
			file: draft.file,
			detail: "the path is not inside a JSON object",
		}
	);
}

export function setEnableProfiles(draft: ConfigDraft, value: boolean): ConfigDraft {
	return applyModify(draft, ["enableProfiles"], value);
}

export function setModel(draft: ConfigDraft, name: string, model: string | undefined): ConfigDraft {
	return applyModify(draft, ["profiles", name, "model"], model);
}

export function setThinking(
	draft: ConfigDraft,
	name: string,
	thinking: ThinkingLevel | undefined,
): ConfigDraft {
	// Absent means "inherit this session's level", so an unset is a key removal —
	// writing null would parse as a value and lose the inheritance.
	return applyModify(draft, ["profiles", name, "thinking"], thinking);
}

/** The three name checks both add and rename share, in the order they should fire. */
function nameError(draft: ConfigDraft, name: string): DraftError | undefined {
	if (name.trim() === "") return { kind: "empty-name" };
	if (name === CURRENT_PROFILE) return { kind: "reserved-name", name };
	if (draftProfiles(draft).includes(name)) return { kind: "duplicate-name", name };
	return undefined;
}

export function addProfile(draft: ConfigDraft, name: string): DraftResult {
	const error = nameError(draft, name);
	if (error) return { ok: false, error };
	// An empty value inserts `{}`, not a null or a stub with keys: both fields
	// absent is exactly the built-in `current`'s inherit-everything semantics.
	const next = applyModify(draft, ["profiles", name], {});
	if (next === draft) return { ok: false, error: editRefusal(draft) };
	return { ok: true, draft: next };
}

export function renameProfile(draft: ConfigDraft, from: string, to: string): DraftResult {
	const error = nameError(draft, to);
	if (error) return { ok: false, error };
	// The raw key edit bypasses `applyModify`, so the unparseable guard is here:
	// patching the key of a file that does not parse is still corrupting it.
	const broken = draftError(draft);
	if (broken) return { ok: false, error: broken };

	const tree = parseTree(draft.text);
	if (!tree) return { ok: false, error: { kind: "missing-name", name: from } };
	// `findNodeAtLocation` returns the *value* node; the property's key is the
	// first child of its parent. jsonc-parser has no rename API, so the key is
	// rewritten as one raw text edit and the value — with any comments around it —
	// is never touched.
	const valueNode = findNodeAtLocation(tree, ["profiles", from]);
	const keyNode = valueNode?.parent?.children?.[0];
	if (!keyNode) return { ok: false, error: { kind: "missing-name", name: from } };

	const start = keyNode.offset;
	const end = start + keyNode.length;
	const renamed = { ...draft, text: draft.text.slice(0, start) + JSON.stringify(to) + draft.text.slice(end) };
	return { ok: true, draft: renamed };
}

export function deleteProfile(draft: ConfigDraft, name: string): ConfigDraft {
	// `undefined` removes the property but leaves `profiles` itself, even when it
	// becomes empty — the key existing means "profiles are configured here".
	return applyModify(draft, ["profiles", name], undefined);
}

/**
 * Write atomically: the text lands on a temp file in the target's own directory
 * (same filesystem, so the rename is a true atomic replace) and is renamed over
 * the target. A failed write therefore leaves either the old file or the new
 * one, never a half-written document.
 */
export function writeDraft(draft: ConfigDraft): void {
	// The last line of defence for the one rule with no undo: a file that does not
	// parse is never replaced, whatever the caller believes it is writing. Mutators
	// already refuse on unparseable text, so reaching here means the caller passed
	// the original draft around the screen's own guard.
	if (draftError(draft)) return;
	// Exactly one trailing newline: files ending in one diff cleanly, so collapse
	// whatever the text ends with (nothing, or several) down to a single one.
	const text = draft.text.replace(/\n+$/, "") + "\n";
	mkdirSync(path.dirname(draft.file), { recursive: true });
	const tmp = path.join(path.dirname(draft.file), `.${path.basename(draft.file)}.tmp`);
	writeFileSync(tmp, text);
	renameSync(tmp, draft.file);
}
