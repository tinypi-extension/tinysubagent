/**
 * The two readings the interrupt smoke takes from a live pane.
 *
 * The fixtures are real screens: the busy one is a pi pane running the smoke's
 * `sleep 120` task, the idle one is the same pane after an Esc stopped the turn,
 * and the third is what a pane looks like once pi is gone. The smoke's verdict —
 * "the child stopped" — rests on these, so they are pinned here rather than
 * trusted only to a live run.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { atPrompt, runningTurn } from "../../scripts/pane-state.ts";

/** A child mid-turn: the status line is drawn inside the editor's border. */
const busy = `
 $ sleep 120

 Elapsed 0.0s


── ⠸ Working ───────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
~/Project/tinysubagent-ip-04 (feat/ip-04-smoke-interrupt) • impl-04
↑65k ↓18k R1.0M CH97.4% $0.048 26.5%/200k (auto)  deepseek/deepseek-v4.1-flash
`;

/** The same pane after the interrupt: the status area is cleared, the editor is back. */
const stopped = `
 $ sleep 120

 Operation aborted


────────────────────────────────────────────────────────────────────────────────
~/Project/tinysubagent-ip-04 (feat/ip-04-smoke-interrupt) • impl-04
↑65k ↓18k R1.0M CH97.4% $0.048 26.5%/200k (auto)  deepseek/deepseek-v4.1-flash
`;

/** A pane whose pi is gone: a shell prompt where the editor and footer were. */
const gone = `
 $ sleep 120

 ~/Project/tinysubagent-ip-04
 $ 
`;

describe("runningTurn", () => {
	it("is true while the working status line is on screen", () => {
		assert.equal(runningTurn(busy), true);
	});

	it("is false once the interrupt cleared it", () => {
		assert.equal(runningTurn(stopped), false);
	});

	it("is false for an empty read", () => {
		assert.equal(runningTurn(""), false);
	});

	it("is true for any screen still saying Working, so a stale read fails loudly rather than passing", () => {
		assert.equal(runningTurn("Session saved\nWorking\n"), true);
	});
});

describe("atPrompt", () => {
	it("is true for a live child, busy or stopped", () => {
		assert.equal(atPrompt(busy), true);
		assert.equal(atPrompt(stopped), true);
	});

	it("is false once pi's footer is gone", () => {
		assert.equal(atPrompt(gone), false);
	});

	it("is false for an empty read", () => {
		assert.equal(atPrompt(""), false);
	});
});
