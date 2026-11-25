/**
 * A child's stdout, read for the text it is writing.
 *
 * A child supervised as a process runs pi in `--mode json`, whose stdout is one
 * JSON record per line. The live view wants the assistant's text deltas and
 * nothing else: thinking and tool-call deltas are the child working, not the
 * child's words, and every other record (session header, tool results, the final
 * message) is not a delta at all.
 *
 * Framing follows pi's documented rule for this stream: records are separated by
 * LF and a chunk may end in the middle of a line, so the tail waits for the rest
 * of it. A line that does not parse is skipped, not fatal — stdout is a log, and
 * the reader is a view, never a reason to end a batch.
 *
 * This is deliberately not `parseSessionEntries`: that reads a whole finished
 * transcript, while this must consume an arrival and keep the remainder. The two
 * also answer different questions, and sharing them would couple the live view to
 * the final-summary format.
 */

/** One parsed stdout record, only as deep as the text reader looks. */
interface JsonEvent {
	type?: unknown;
	assistantMessageEvent?: {
		type?: unknown;
		delta?: unknown;
	};
}

/** The text this line contributes, or null when it is not an assistant text delta. */
function textOfLine(line: string): string | null {
	if (line.trim() === "") return null;

	let event: JsonEvent;
	try {
		event = JSON.parse(line) as JsonEvent;
	} catch {
		return null;
	}
	if (event === null || typeof event !== "object") return null;
	if (event.type !== "message_update") return null;

	const delta = event.assistantMessageEvent;
	if (delta === null || typeof delta !== "object") return null;
	if (delta.type !== "text_delta" || typeof delta.delta !== "string") return null;
	return delta.delta;
}

/**
 * Build a reader for one child's stdout. Each call to the returned function is
 * one chunk; the callback sees one text delta at a time, in order, with a record
 * split across chunks delivered once.
 */
export function createEventTextReader(onText: (text: string) => void): (chunk: string) => void {
	let buffer = "";

	return (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			// A CRLF stream carries the CR in the line, not in the JSON.
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			const text = textOfLine(line);
			if (text !== null) onText(text);
			newline = buffer.indexOf("\n");
		}
	};
}
