import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { type ToolRunCall, ToolRunSummaryComponent } from "@oh-my-pi/pi-tui/chrome/tool-run-summary";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Text } from "@oh-my-pi/pi-tui";

const W = 100;

/** A tool-call block: one row while tool activity shows, nothing while hidden. */
class FakeTool implements Component {
	calls: ToolRunCall[];
	#visible = true;

	constructor(...calls: ToolRunCall[]) {
		this.calls = calls;
	}

	setToolActivityVisible(visible: boolean): void {
		this.#visible = visible;
	}

	toolRunCalls(): readonly ToolRunCall[] {
		return this.calls;
	}

	render(): readonly string[] {
		return this.#visible ? [`tool ${this.calls.map(call => call.tool).join("+")}`] : [];
	}

	invalidate(): void {}
}

const done = (tool: string, args: unknown = {}, details?: unknown): ToolRunCall => ({
	tool,
	args,
	details,
	state: "done",
});

function assistant(content: AssistantMessage["content"]): AssistantMessageComponent {
	return new AssistantMessageComponent({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	});
}

function transcript(hidden: boolean): TranscriptContainer {
	const container = new TranscriptContainer();
	container.setToolRunSummaries(true);
	container.setToolActivityVisible(!hidden);
	return container;
}

const lines = (container: TranscriptContainer) =>
	container
		.render(W)
		.map(row => Bun.stripANSI(row).trim())
		.filter(row => row.length > 0);

const summaries = (container: TranscriptContainer) =>
	container.children.filter(child => child instanceof ToolRunSummaryComponent);

beforeAll(async () => {
	await initTheme(false);
});

describe("tool run summaries", () => {
	it("folds a run that spans tool-only assistant messages into one line", () => {
		const container = transcript(true);
		container.addChild(new Text("Let me look.", 1, 0));
		container.addChild(new FakeTool(done("read", { path: "a.ts" }), done("read", { path: "b.ts" })));
		container.addChild(assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }]));
		container.addChild(new FakeTool(done("read", { path: "a.ts" })));
		container.addChild(
			new FakeTool(
				done("edit", { path: "a.ts" }, { diff: "+one\n+two\n-three\n context" }),
				done("grep", { pattern: "x" }),
				{ ...done("bash", { command: "false" }), state: "failed" },
				done("bash", { command: "true" }),
			),
		);
		container.addChild(new Text("Done.", 1, 0));

		expect(summaries(container)).toHaveLength(1);
		expect(lines(container)).toEqual([
			"Let me look.",
			"● Read 2 files, edited 1 file +2 −1, searched 1×, ran 2 commands, 1 failed",
			"Done.",
		]);
	});

	it("starts a new run after a block that draws something", () => {
		const container = transcript(true);
		container.addChild(new FakeTool(done("read", { path: "a.ts" })));
		container.addChild(new Text("Found it.", 1, 0));
		container.addChild(new FakeTool(done("bash", { command: "ls" })));

		expect(summaries(container)).toHaveLength(2);
		expect(lines(container)).toEqual(["● Read 1 file", "Found it.", "● Ran 1 command"]);
	});

	it("shows the running call and stays live until the run ends and settles", () => {
		const container = transcript(true);
		const tool = new FakeTool(done("read", { path: "a.ts" }), {
			tool: "bash",
			args: { command: "bun test\n--watch" },
			state: "running",
		});
		container.addChild(tool);
		const [summary] = summaries(container);

		expect(lines(container)[0]).toMatch(/^[◐◓◑◒] Read 1 file · running bun test…$/);
		expect(summary!.isTranscriptBlockFinalized()).toBe(false);

		tool.calls[1] = done("bash", { command: "bun test" });
		expect(summary!.isTranscriptBlockFinalized()).toBe(false);

		container.addChild(new Text("All green.", 1, 0));
		expect(summary!.isTranscriptBlockFinalized()).toBe(true);
		expect(lines(container)).toEqual(["● Read 1 file, ran 1 command", "All green."]);
	});

	it("starts an agent per batch task item and skips housekeeping calls", () => {
		const container = transcript(true);
		container.addChild(new FakeTool(done("todo"), done("task", { tasks: [{}, {}, {}] }), done("wait")));

		expect(lines(container)).toEqual(["● Started 3 agents"]);
	});

	it("draws nothing while tool activity shows, and the tools instead", () => {
		const container = transcript(false);
		container.addChild(new FakeTool(done("read", { path: "a.ts" })));

		expect(lines(container)).toEqual(["tool read"]);
		container.setToolActivityVisible(false);
		expect(lines(container)).toEqual(["● Read 1 file"]);
	});

	it("colors only the failure count, not the separator before it", () => {
		const container = transcript(true);
		container.addChild(new FakeTool(done("read", { path: "a.ts" }), { ...done("bash"), state: "failed" }));
		const [summary] = summaries(container);
		const line = summary!.render(W)[0]!;

		expect(line).toContain(`${theme.fg("muted", ", ")}${theme.fg("error", "1 failed")}`);
	});

	it("adds no summaries when turned off", () => {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(false);
		container.addChild(new FakeTool(done("read", { path: "a.ts" })));

		expect(summaries(container)).toHaveLength(0);
		expect(lines(container)).toEqual([]);
	});

	it("drops trailing phrases before cutting a line that does not fit", () => {
		const container = transcript(true);
		container.addChild(
			new FakeTool(done("read", { path: "a.ts" }), done("grep"), done("bash"), done("eval"), done("web_search")),
		);
		const [summary] = summaries(container);

		expect(Bun.stripANSI(summary!.render(40)[0]!)).toBe(" ● Read 1 file, searched 1×, …");
	});
});
