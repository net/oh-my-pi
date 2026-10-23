import { formatDuration, pluralize } from "@oh-my-pi/pi-utils";
import { span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { getDiffStats } from "../render/render-utils";
import { type ThemeColor, theme } from "../theme";
import { type Component, Container } from "../tui";
import { truncateToWidth, visibleWidth } from "../utils";
import { isToolActivityComponent, type ToolActivityComponent } from "./tool-activity";

/** One tool call as a run summary counts it. */
export interface ToolRunCall {
	tool: string;
	args: unknown;
	/** The final result's details; edits read their diff from it. */
	details?: unknown;
	state: "running" | "done" | "failed";
	/** `performance.now()` when execution started and settled, for the run's wall time. */
	startedAt?: number;
	endedAt?: number;
}

/** A transcript block that carries tool calls a run summary can count. */
export interface ToolRunSource {
	toolRunCalls(): readonly ToolRunCall[];
}

export function isToolRunSource(component: Component): component is Component & ToolRunSource {
	return typeof (component as Partial<ToolRunSource>).toolRunCalls === "function";
}

/** Whether `component` draws any non-blank row at `width`. */
export function rendersContent(component: Component, width: number): boolean {
	return component.render(width).some(row => Bun.stripANSI(row).trim().length > 0);
}

interface Category {
	key: string;
	/** Counts each file once (reads, edits). */
	byPath?: boolean;
	phrase(count: number): string;
}

const counted = (count: number, word: string): string => `${count} ${pluralize(word, count)}`;

const READ: Category = { key: "read", byPath: true, phrase: n => `read ${counted(n, "file")}` };
const EDIT: Category = { key: "edit", byPath: true, phrase: n => `edited ${counted(n, "file")}` };
const SEARCH: Category = { key: "search", phrase: n => `searched ${n}×` };
const BASH: Category = { key: "bash", phrase: n => `ran ${counted(n, "command")}` };
const EVAL: Category = { key: "eval", phrase: n => `ran ${counted(n, "script")}` };
const TASK: Category = { key: "task", phrase: n => `started ${counted(n, "agent")}` };
const WEB: Category = { key: "web", phrase: n => `searched the web ${n}×` };

/** Housekeeping calls (`todo`, `wait`, `ask`) show their own UI and are not counted. */
function categorize(tool: string): Category | undefined {
	switch (tool) {
		case "read":
			return READ;
		case "edit":
		case "write":
		case "ast_edit":
		case "apply_patch":
			return EDIT;
		case "grep":
		case "glob":
		case "find":
		case "ast_grep":
			return SEARCH;
		case "bash":
			return BASH;
		case "eval":
			return EVAL;
		case "task":
			return TASK;
		case "web_search":
			return WEB;
		case "todo":
		case "wait":
		case "ask":
			return undefined;
		default:
			return { key: `tool:${tool}`, phrase: n => (n === 1 ? `used ${tool}` : `used ${tool} ${n}×`) };
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown, ...keys: string[]): string | undefined {
	const fields = record(value);
	for (const key of keys) {
		const field = fields?.[key];
		if (typeof field === "string" && field.length > 0) return field;
	}
	return undefined;
}

/** Per-file results of a multi-file edit, else the call's single result. */
function fileResults(call: ToolRunCall): readonly unknown[] {
	const perFile = record(call.details)?.perFileResults;
	return Array.isArray(perFile) && perFile.length > 0 ? perFile : [call.details];
}

/** The files a read or edit touched, for counting each file once. */
function callPaths(call: ToolRunCall): string[] {
	const paths = fileResults(call)
		.map(result => stringField(result, "path"))
		.filter((path): path is string => path !== undefined);
	if (paths.length > 0) return paths;
	const argPath = stringField(call.args, "path", "file_path");
	return argPath ? [argPath] : [];
}

/** A batch `task` call starts one agent per item. */
function callWeight(call: ToolRunCall): number {
	const tasks = record(call.args)?.tasks;
	return call.tool === "task" && Array.isArray(tasks) && tasks.length > 0 ? tasks.length : 1;
}

function stepText(call: ToolRunCall): string {
	const firstLine = (value: string | undefined) => value?.split("\n", 1)[0]?.trim();
	const path = stringField(call.args, "path", "file_path");
	const target = (verb: string, subject: string | undefined) => (subject ? `${verb} ${subject}` : verb);
	switch (call.tool) {
		case "bash":
			return target("running", firstLine(stringField(call.args, "command")));
		case "read":
			return target("reading", path);
		case "grep":
		case "glob":
		case "find":
		case "ast_grep":
			return target("searching", stringField(call.args, "pattern") ?? path);
		case "edit":
		case "write":
		case "ast_edit":
		case "apply_patch":
			return target("editing", path);
		case "eval":
			return "running a script";
		case "task":
			return "running agents";
		case "web_search":
			return "searching the web";
		default:
			return `running ${call.tool}`;
	}
}

interface RunSummary {
	/** Category phrases in order of first appearance, e.g. `read 4 files`. */
	parts: string[];
	failed: number;
	/** What the first unsettled call is doing, e.g. `running git status`. */
	step: string | undefined;
	wallMs: number | undefined;
}

function summarize(calls: readonly ToolRunCall[]): RunSummary {
	const tally = new Map<string, { category: Category; count: number; seen: Set<string> }>();
	let added = 0;
	let removed = 0;
	let failed = 0;
	let step: string | undefined;
	for (const call of calls) {
		if (call.state === "failed") failed++;
		if (call.state === "running") {
			step ??= stepText(call);
			continue;
		}
		const category = categorize(call.tool);
		if (!category) continue;
		let entry = tally.get(category.key);
		if (!entry) {
			entry = { category, count: 0, seen: new Set() };
			tally.set(category.key, entry);
		}
		if (category.byPath) {
			const paths = callPaths(call);
			const fresh = paths.filter(path => !entry.seen.has(path));
			for (const path of fresh) entry.seen.add(path);
			entry.count += paths.length === 0 ? 1 : fresh.length;
		} else {
			entry.count += callWeight(call);
		}
		if (category === EDIT && call.state === "done") {
			for (const result of fileResults(call)) {
				const diff = stringField(result, "diff");
				if (!diff) continue;
				const stats = getDiffStats(diff);
				added += stats.added;
				removed += stats.removed;
			}
		}
	}
	const parts: string[] = [];
	for (const { category, count } of tally.values()) {
		if (count === 0) continue;
		let phrase = category.phrase(count);
		if (category === EDIT && (added > 0 || removed > 0)) {
			phrase += ` ${[added > 0 ? `+${added}` : "", removed > 0 ? `\u2212${removed}` : ""].filter(Boolean).join(" ")}`;
		}
		parts.push(phrase);
	}
	let wallMs: number | undefined;
	if (step === undefined) {
		let start = Number.POSITIVE_INFINITY;
		let end = Number.NEGATIVE_INFINITY;
		for (const call of calls) {
			if (call.startedAt === undefined || call.endedAt === undefined) continue;
			start = Math.min(start, call.startedAt);
			end = Math.max(end, call.endedAt);
		}
		if (end > start) wallMs = end - start;
	}
	return { parts, failed, step, wallMs };
}

interface Segment {
	text: string;
	color: ThemeColor;
}

const SPINNER = ["◐", "◓", "◑", "◒"];
const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * `● Read 4 files, edited 2 files +6 −2, ran 2 commands, 1 failed · 6.1s`, or
 * `◐ Read 2 files · running bun test…` while a call runs; `[]` when the run
 * holds nothing countable. Trailing phrases give way to `…` before the line
 * is cut to `width`.
 */
function summarySegments(summary: RunSummary, width: number): Segment[] {
	const running = summary.step !== undefined;
	const failed = summary.failed > 0 ? `${summary.failed} failed` : "";
	if (summary.parts.length === 0 && !failed && !running) return [];
	const glyph = running ? (SPINNER[Math.floor(performance.now() / 150) % SPINNER.length] ?? "◐") : "●";
	let tail = "";
	if (running) tail = `${summary.step}…`;
	else if (summary.wallMs !== undefined) tail = formatDuration(summary.wallMs);

	const build = (parts: readonly string[], keepTail: boolean): Segment[] => {
		const lead: Segment[] = [];
		if (parts.length > 0) lead.push({ text: parts.join(", "), color: "muted" });
		if (failed) lead.push({ text: lead.length > 0 ? `, ${failed}` : failed, color: "error" });
		if (keepTail && tail) lead.push({ text: lead.length > 0 ? ` · ${tail}` : tail, color: "dim" });
		const first = lead[0];
		if (first) first.text = capitalize(first.text);
		return [{ text: `${glyph} `, color: running ? "accent" : "success" }, ...lead];
	};
	const fits = (segments: readonly Segment[]) =>
		segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0) <= width;

	let segments = build(summary.parts, true);
	if (fits(segments)) return segments;
	segments = build(summary.parts, running);
	for (let keep = summary.parts.length - 1; !fits(segments) && keep >= 1; keep--) {
		segments = build([...summary.parts.slice(0, keep), "…"], running);
	}
	let room = width;
	for (const segment of segments) {
		segment.text = room > 0 ? truncateToWidth(segment.text, room) : "";
		room -= visibleWidth(segment.text);
	}
	return segments.filter(segment => segment.text.length > 0);
}

/**
 * One line standing in for a run of hidden tool calls: the tool-call blocks
 * that follow it in the transcript, up to the next block that draws anything.
 * It renders only while tool activity is hidden, and stays live until a
 * visible block ends the run and every counted call settled, so its line can
 * keep changing until then.
 */
export class ToolRunSummaryComponent extends Container implements ToolActivityComponent {
	readonly #transcript: Container;
	#toolActivityVisible = true;
	#width = 80;

	constructor(transcript: Container) {
		super();
		this.#transcript = transcript;
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	/** The calls of this run, and whether a later visible block has ended it. */
	#scan(): { calls: ToolRunCall[]; closed: boolean } {
		const children = this.#transcript.children;
		const calls: ToolRunCall[] = [];
		const start = children.indexOf(this);
		if (start < 0) return { calls, closed: true };
		for (let index = start + 1; index < children.length; index++) {
			const child = children[index]!;
			if (child instanceof ToolRunSummaryComponent) return { calls, closed: true };
			if (isToolRunSource(child)) {
				calls.push(...child.toolRunCalls());
				continue;
			}
			if (isToolActivityComponent(child)) continue;
			if (rendersContent(child, this.#width)) return { calls, closed: true };
		}
		return { calls, closed: false };
	}

	isTranscriptBlockFinalized(): boolean {
		if (this.#toolActivityVisible) return true;
		const { calls, closed } = this.#scan();
		return closed && calls.every(call => call.state !== "running");
	}

	override render(width: number): readonly string[] {
		this.#width = width;
		if (this.#toolActivityVisible || width < 2) return [];
		const segments = summarySegments(summarize(this.#scan().calls), width - 1);
		if (segments.length === 0) return [];
		return [` ${segments.map(segment => theme.fg(segment.color, segment.text)).join("")}`];
	}

	override describe(): NativeNode {
		const segments = this.#toolActivityVisible ? [] : summarySegments(summarize(this.#scan().calls), this.#width);
		return text(
			segments.map(segment => span(segment.text, segment.color)),
			{ wrap: "none", role: "omp.tool.summary", hidden: segments.length === 0 ? true : undefined },
		);
	}
}
