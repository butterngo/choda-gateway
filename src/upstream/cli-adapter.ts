import { spawn } from "node:child_process";
import type { Tool } from "../manifest/types.js";
import type {
	AdapterContext,
	NormalizedToolCall,
	NormalizedToolResult,
	UpstreamAdapter,
} from "../types.js";
import { resolveTemplate } from "../util/template.js";
import {
	AdapterTimeoutError,
	type Semaphore,
	createSemaphore,
	withSlot,
} from "./upstream-adapter.js";

const SUCCESS_EXIT_CODES: readonly number[] = [0];

interface CliUpstream {
	type: "cli";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

function assertCli(
	tool: Tool,
): asserts tool is Tool & { upstream: CliUpstream } {
	if (tool.upstream.type !== "cli") {
		throw new Error(
			`createCliAdapter requires a cli tool, got '${tool.upstream.type}'`,
		);
	}
}

export function createCliAdapter(tool: Tool): UpstreamAdapter {
	assertCli(tool);
	if (tool.concurrency !== 1) {
		throw new Error(
			`cli adapter requires concurrency=1 (ADR-004), got ${tool.concurrency}`,
		);
	}
	if (tool.retryPolicy !== "none") {
		throw new Error(
			`cli adapter requires retryPolicy=none (ADR-004), got '${tool.retryPolicy}'`,
		);
	}

	const upstream = tool.upstream;
	const sem: Semaphore = createSemaphore(1);
	let ctx: AdapterContext | null = null;

	return {
		type: "cli",
		async init(context) {
			ctx = context;
		},
		async call(normalized) {
			const localCtx = ctx;
			if (!localCtx) throw new Error("cli adapter not initialized");
			return withSlot(sem, () => execute(tool, upstream, localCtx, normalized));
		},
		async dispose() {
			// per-call ephemeral spawn; nothing to release between calls.
		},
	};
}

async function execute(
	tool: Tool,
	upstream: CliUpstream,
	ctx: AdapterContext,
	call: NormalizedToolCall,
): Promise<NormalizedToolResult> {
	const tplCtx = { input: call.input, secrets: ctx.secrets };
	const args = resolveTemplate(upstream.args ?? [], tplCtx);
	const env = resolveTemplate(upstream.env ?? {}, tplCtx);

	const controller = new AbortController();
	const t0 = performance.now();
	let timedOut = false;
	const timeoutMs = call.policy.timeoutMs;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	const child = spawn(upstream.command, args, {
		shell: false,
		env: { ...process.env, ...env },
		cwd: upstream.cwd,
		signal: controller.signal,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
	child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

	const exit = await new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		err: Error | null;
	}>((resolve) => {
		child.once("error", (err) =>
			resolve({ code: null, signal: null, err: err as Error }),
		);
		child.once("close", (code, signal) => resolve({ code, signal, err: null }));
	});
	clearTimeout(timer);

	const durationMs = Math.round(performance.now() - t0);
	const stdout = Buffer.concat(stdoutChunks).toString("utf8");
	const stderr = Buffer.concat(stderrChunks).toString("utf8");
	if (stderr) {
		ctx.logger.debug("cli stderr", {
			toolName: call.toolName,
			correlationId: call.correlationId,
			stderr,
		});
	}

	if (timedOut) {
		throw new AdapterTimeoutError(timeoutMs);
	}
	if (exit.err) {
		// spawn-level failure (ENOENT, EACCES). Not a tool-result error — infra fail.
		throw exit.err;
	}

	const ok = exit.code !== null && SUCCESS_EXIT_CODES.includes(exit.code);
	const text = ok ? stdout : stderr || stdout || `exit ${exit.code}`;
	const result: NormalizedToolResult = {
		content: [{ type: "text", text }],
		meta: {
			durationMs,
			exitCode: exit.code ?? -1,
		},
	};
	if (!ok) result.isError = true;
	return result;
}
