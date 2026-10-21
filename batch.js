// Ported unchanged in behavior from pi-event-monitor-batched extensions/batch.ts (MIT).
import { StringDecoder } from "node:string_decoder";

export const MAX_LINE_BYTES = 256;
export const MAX_INTERVAL_MINUTES = 2_147_483_647 / 60_000;

export function intervalMilliseconds(minutes = 30) {
	if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_INTERVAL_MINUTES || minutes * 60_000 < 1) {
		throw new Error(`interval_minutes must be finite and between ${1 / 60_000} and ${MAX_INTERVAL_MINUTES}.`);
	}
	return Math.floor(minutes * 60_000);
}

export function truncateUtf8(line) {
	if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
	const marker = "… [truncated]";
	let output = "";
	let bytes = 0;
	for (const char of line) {
		const size = Buffer.byteLength(char);
		if (bytes + size > MAX_LINE_BYTES - Buffer.byteLength(marker)) break;
		output += char;
		bytes += size;
	}
	return output + marker;
}

/** Constant-memory first-three / last-twenty summary. Short batches never overlap. */
export class OutputBatch {
	head = [];
	tail = [];
	count = 0;
	add(line) {
		this.count++;
		if (this.head.length < 3) this.head.push(truncateUtf8(line));
		else {
			this.tail.push(truncateUtf8(line));
			if (this.tail.length > 20) this.tail.shift();
		}
	}
	drain() {
		const omitted = this.count - this.head.length - this.tail.length;
		const result = [...this.head, ...(omitted > 0 ? [`… [${omitted} lines omitted]`] : []), ...this.tail];
		this.head = [];
		this.tail = [];
		this.count = 0;
		return result;
	}
}

/** Decode split UTF-8 safely and cap even a stream that never emits a newline. */
export class BoundedLines {
	decoder = new StringDecoder("utf8");
	prefix = "";
	bytes = 0;
	overflow = false;
	constructor(emit) {
		this.emit = emit;
	}
	write(chunk) {
		this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
	}
	consume(text) {
		for (const char of text) {
			if (char === "\n") { this.flush(true); continue; }
			if (this.overflow) continue;
			this.prefix += char;
			this.bytes += Buffer.byteLength(char);
			if (this.bytes > MAX_LINE_BYTES) this.overflow = true;
		}
	}
	flush(completedLine = false) {
		const line = this.prefix.replace(/\r$/, "");
		if (line.length > 0 || completedLine) this.emit(truncateUtf8(line));
		this.prefix = "";
		this.bytes = 0;
		this.overflow = false;
	}
	end() { this.consume(this.decoder.end()); this.flush(); }
}
