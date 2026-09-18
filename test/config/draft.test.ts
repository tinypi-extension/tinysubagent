import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

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
} from "../../src/config/draft.ts";

/** A fresh temp dir, so no test ever touches the real `~/.pi`. */
function tempDir(): string {
	return mkdtempSync(path.join(tmpdir(), "tinysubagent-draft-"));
}

/** A draft over a file that exists, holding the given raw text. */
function draftWith(text: string): { draft: ReturnType<typeof readDraft>; file: string } {
	const file = path.join(tempDir(), "tinysubagent.jsonc");
	writeFileSync(file, text);
	return { draft: readDraft(file), file };
}

/** A draft over a file that does not exist — the "first edit creates it" state. */
function missingDraft(): { draft: ReturnType<typeof readDraft>; file: string } {
	const file = path.join(tempDir(), "tinysubagent.jsonc");
	return { draft: readDraft(file), file };
}

// A document with everything worth preserving: a comment outside profiles, a
// sibling comment inside one, and an inline profile object.
const DOC = `{
	// Profile roster, hand-tuned.
	"enableProfiles": true,
	"profiles": {
		// work laptop
		"work": { "model": "oc-openai/glm-5.3-flash", "thinking": "high" },
		"quick": { "model": "oc-openai/deepseek-flash" }
	},
}
`;

test("setModel and setThinking change one value and preserve a comment elsewhere", () => {
	const { draft } = draftWith(DOC);
	const edited = setThinking(setModel(draft, "work", "oc-openai/other-model"), "work", "low");
	assert.ok(edited.text.includes("// Profile roster, hand-tuned."), "roster comment lost");
	assert.ok(edited.text.includes("// work laptop"), "sibling comment lost");
	assert.ok(edited.text.includes('"oc-openai/other-model"'));
	assert.ok(edited.text.includes('"thinking": "low"'), "thinking not updated");
	assert.equal(draftProfile(edited, "work").thinking, "low");
	// The untouched sibling keeps its inline shape and its own value.
	assert.ok(edited.text.includes('"quick"'), "sibling profile lost");
	assert.equal(draftProfile(edited, "quick").model, "oc-openai/deepseek-flash");
});

test("setThinking(name, undefined) removes the key rather than writing null", () => {
	const { draft } = draftWith(DOC);
	const edited = setThinking(draft, "work", undefined);
	assert.equal(edited.text.includes("null"), false);
	assert.equal(/"thinking"/.test(edited.text.split('"work"')[1] ?? ""), false, "thinking key still present");
	assert.equal(draftProfile(edited, "work").thinking, undefined);
	assert.ok(edited.text.includes("// Profile roster, hand-tuned."), "comment lost on unset");
});

test("addProfile inserts an empty object with no model or thinking keys", () => {
	const { draft } = draftWith(DOC);
	const result = addProfile(draft, "pro");
	assert.ok(result.ok);
	// Asserting on text, not on a re-parse: the rule is about what is written.
	assert.ok(/"pro"\s*:\s*\{\s*\}/.test(result.draft.text), `expected empty object for pro`);
	assert.ok(result.draft.text.includes("// Profile roster, hand-tuned."), "comment lost on add");
});

test("addProfile on empty text creates the profiles object and the root", () => {
	const { draft } = missingDraft();
	const result = addProfile(draft, "pro");
	assert.ok(result.ok);
	assert.deepEqual(draftProfiles(result.draft), ["pro"]);
	assert.deepEqual(draftProfile(result.draft, "pro"), {});
	assert.equal(draftEnableProfiles(result.draft), false);
});

test("addProfile refuses current, empty, and duplicate names", () => {
	const { draft } = draftWith(DOC);
	const reserved = addProfile(draft, "current");
	assert.ok(!reserved.ok);
	assert.deepEqual(reserved.error, { kind: "reserved-name", name: "current" });
	const empty = addProfile(draft, "  ");
	assert.ok(!empty.ok);
	assert.deepEqual(empty.error, { kind: "empty-name" });
	const duplicate = addProfile(draft, "work");
	assert.ok(!duplicate.ok);
	assert.deepEqual(duplicate.error, { kind: "duplicate-name", name: "work" });
	// A refusal leaves the draft byte-identical — the file is never half-edited.
	assert.equal(draft.text, DOC, "refused add changed the draft text");
});

test("renameProfile rewrites the key and leaves the value and comments intact", () => {
	const { draft } = draftWith(DOC);
	const result = renameProfile(draft, "work", "office");
	assert.ok(result.ok);
	assert.ok(result.draft.text.includes('"office"'), "new key missing");
	assert.equal(result.draft.text.includes('"work"'), false, "old key still present");
	assert.ok(result.draft.text.includes("// work laptop"), "comment above the key lost");
	assert.ok(result.draft.text.includes('"oc-openai/glm-5.3-flash"'), "value lost on rename");
	assert.deepEqual(draftProfile(result.draft, "office"), {
		model: "oc-openai/glm-5.3-flash",
		thinking: "high",
	});
	// Renaming onto an existing or reserved name is refused, like add.
	const duplicate = renameProfile(draft, "work", "quick");
	assert.ok(!duplicate.ok);
	assert.deepEqual(duplicate.error, { kind: "duplicate-name", name: "quick" });
	const reserved = renameProfile(draft, "work", "current");
	assert.ok(!reserved.ok);
	assert.deepEqual(reserved.error, { kind: "reserved-name", name: "current" });
});

test("deleteProfile removes the property but keeps profiles and sibling comments", () => {
	const { draft } = draftWith(DOC);
	const edited = deleteProfile(draft, "work");
	assert.equal(edited.text.includes('"work"'), false, "deleted profile still present");
	assert.ok(edited.text.includes('"profiles"'), "profiles key dropped");
	assert.ok(edited.text.includes('"quick"'), "sibling profile lost");
	assert.ok(edited.text.includes("// Profile roster, hand-tuned."), "outer comment lost");
	assert.deepEqual(draftProfiles(edited), ["quick"]);
});

test("writeDraft creates the parent directory and a second write is idempotent", () => {
	const dir = path.join(tempDir(), "nested", "deeper");
	const file = path.join(dir, "tinysubagent.jsonc");
	const draft = { file, text: '{\n\t"enableProfiles": true\n}' };
	writeDraft(draft);
	assert.equal(existsSync(file), true);
	assert.equal(readFileSync(file, "utf-8"), draft.text + "\n", "no single trailing newline added");

	writeDraft(draft);
	assert.equal(readFileSync(file, "utf-8"), draft.text + "\n", "second write changed the bytes");
	assert.deepEqual(readDraft(file).text, draft.text + "\n");
});

test("an unparseable file surfaces unparseable and no edit or write changes it", () => {
	const file = path.join(tempDir(), "tinysubagent.jsonc");
	const broken = '{ "enableProfiles": true, not json';
	writeFileSync(file, broken);
	const draft = readDraft(file);
	const error = draftError(draft);
	assert.equal(error?.kind, "unparseable");
	assert.equal(error?.file, file);
	assert.ok(error && "detail" in error && error.detail.length > 0, "no parse detail given");

	// Every mutator refuses: the text comes back untouched, and nothing lands on disk.
	for (const unchanged of [
		setEnableProfiles(draft, false),
		setModel(draft, "work", "m"),
		setThinking(draft, "work", "low"),
		deleteProfile(draft, "work"),
	]) {
		assert.equal(unchanged.text, broken);
	}
	assert.equal(addProfile(draft, "pro").ok, false);
	assert.equal(renameProfile(draft, "a", "b").ok, false);

	writeDraft(setEnableProfiles(draft, false));
	assert.equal(readFileSync(file, "utf-8"), broken, "unparseable file was written over");

	// A read-side helper stays total on the same file instead of throwing.
	assert.equal(draftEnableProfiles(draft), false);
	assert.deepEqual(draftProfiles(draft), []);
	assert.deepEqual(draftProfile(draft, "work"), {});
});

test("an unknown extra field on a profile survives an unrelated edit", () => {
	const file = path.join(tempDir(), "tinysubagent.jsonc");
	writeFileSync(
		file,
		`{
	"profiles": {
		"work": { "model": "m", "note": "hand-written, screen does not know it" },
	},
}
`,
	);
	const edited = setModel(readDraft(file), "work", "m2");
	// The point is byte-level: the field is still in the text, not just re-parseable.
	assert.ok(edited.text.includes('"note": "hand-written, screen does not know it"'), "extra field lost");
});

test("a document that parses but cannot hold an edit is refused, not thrown", () => {
	// `jsonc-parser`'s `modify` throws when a path's parent is not an object, and a
	// throw would come out of a keypress in the screen. Each of these parses as
	// valid JSONC, so nothing but a shape check stands between them and a crash.
	const cases: { text: string; detail: string }[] = [
		{ text: "[1, 2]\n", detail: "array root" },
		{ text: '"just a string"\n', detail: "scalar root" },
		{ text: '{ "profiles": [] }\n', detail: "profiles as an array" },
		{ text: '{ "profiles": 5 }\n', detail: "profiles as a number" },
		{ text: '{ "profiles": { "work": 5 } }\n', detail: "a profile as a number" },
	];

	for (const { text, detail } of cases) {
		const draft = { file: path.join(tempDir(), "tinysubagent.jsonc"), text };
		const error = draftError(draft);
		assert.equal(error?.kind, "invalid-shape", `${detail}: expected invalid-shape`);
		assert.equal(error?.kind === "invalid-shape" && error.file, draft.file, `${detail}: error names the file`);

		// Every mutator returns the text untouched rather than throwing or half-editing.
		for (const unchanged of [
			setEnableProfiles(draft, true),
			setModel(draft, "work", "m"),
			setThinking(draft, "work", "low"),
			deleteProfile(draft, "work"),
		]) {
			assert.equal(unchanged.text, text, `${detail}: mutation changed the text`);
		}
		const added = addProfile(draft, "pro");
		assert.equal(added.ok, false, `${detail}: add was allowed`);
		assert.equal(added.ok === false && added.error.kind, "invalid-shape", `${detail}: add error kind`);
		assert.equal(renameProfile(draft, "work", "renamed").ok, false, `${detail}: rename was allowed`);

		// And `writeDraft` refuses the same draft outright: it is not created, let
		// alone replaced.
		writeDraft(setEnableProfiles(draft, true));
		assert.equal(existsSync(draft.file), false, `${detail}: a file was written`);

		// Read-side helpers stay total on the same file.
		assert.equal(draftEnableProfiles(draft), false);
		assert.doesNotThrow(() => draftProfiles(draft));
	}
});
