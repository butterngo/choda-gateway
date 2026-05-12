import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "../manifest/types.js";
import type {
	AdapterContext,
	NormalizedContentItem,
	NormalizedToolCall,
	NormalizedToolResult,
	UpstreamAdapter,
} from "../types.js";
import {
	AdapterTimeoutError,
	type Semaphore,
	createSemaphore,
	withSlot,
	withTimeout,
} from "./upstream-adapter.js";

interface McpUpstream {
	type: "mcp";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	remoteTool: string;
}

function assertMcp(
	tool: Tool,
): asserts tool is Tool & { upstream: McpUpstream } {
	if (tool.upstream.type !== "mcp") {
		throw new Error(
			`createMcpAdapter requires an mcp tool, got '${tool.upstream.type}'`,
		);
	}
}

export interface McpAdapterOptions {
	clientName?: string;
	clientVersion?: string;
}

export function createMcpAdapter(
	tool: Tool,
	opts: McpAdapterOptions = {},
): UpstreamAdapter {
	assertMcp(tool);
	const upstream = tool.upstream;
	const sem: Semaphore = createSemaphore(tool.concurrency);
	let ctx: AdapterContext | null = null;
	let client: Client | null = null;
	let transport: StdioClientTransport | null = null;
	let exitReason: Error | null = null;

	return {
		type: "mcp",
		async init(context) {
			ctx = context;
			transport = new StdioClientTransport({
				command: upstream.command,
				args: upstream.args ?? [],
				env: upstream.env
					? { ...filterEnv(process.env), ...upstream.env }
					: filterEnv(process.env),
				stderr: "pipe",
			});
			client = new Client(
				{
					name: opts.clientName ?? "choda-gateway",
					version: opts.clientVersion ?? "0.0.0",
				},
				{ capabilities: {} },
			);

			// Drain stderr into adapter logger so upstream noise doesn't leak to gateway stdout.
			transport.stderr?.on("data", (chunk: Buffer) => {
				const line = chunk.toString("utf8").trimEnd();
				if (line) {
					context.logger.debug("mcp upstream stderr", {
						upstream: context.upstreamName,
						line,
					});
				}
			});
			transport.onclose = () => {
				exitReason ??= new McpUpstreamClosedError(
					`mcp upstream '${context.upstreamName}' closed unexpectedly`,
				);
			};
			transport.onerror = (err) => {
				exitReason ??= err;
			};

			await client.connect(transport);
		},
		async call(normalized) {
			const localClient = client;
			if (!ctx || !localClient) throw new Error("mcp adapter not initialized");
			if (exitReason) throw exitReason;
			return withSlot(sem, () =>
				executeCall(localClient, upstream, normalized, () => exitReason),
			);
		},
		async dispose() {
			if (!client) return;
			try {
				await client.close();
			} catch {
				// transport may already be closed (child died); swallow.
			}
			client = null;
			transport = null;
		},
	};
}

export class McpUpstreamClosedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpUpstreamClosedError";
	}
}

async function executeCall(
	client: Client,
	upstream: McpUpstream,
	call: NormalizedToolCall,
	getExitReason: () => Error | null,
): Promise<NormalizedToolResult> {
	const t0 = performance.now();
	const callPromise = client.callTool({
		name: upstream.remoteTool,
		arguments: call.input,
	}) as Promise<RawToolResult>;

	let raw: RawToolResult;
	try {
		raw = await withTimeout(callPromise, call.policy.timeoutMs);
	} catch (err) {
		if (err instanceof AdapterTimeoutError) throw err;
		// If the upstream closed mid-call, surface the close error rather than the
		// transport-level "connection closed" message — easier for the router to map.
		const exit = getExitReason();
		if (exit) throw exit;
		throw err;
	}

	const durationMs = Math.round(performance.now() - t0);
	const content = mapContent(raw.content);
	const result: NormalizedToolResult = {
		content,
		meta: { durationMs },
	};
	if (raw.structuredContent !== undefined) {
		result.structuredContent = raw.structuredContent;
	}
	if (raw.isError) result.isError = true;
	return result;
}

interface RawToolContentText {
	type: "text";
	text: string;
}
interface RawToolContentImage {
	type: "image";
	data: string;
	mimeType: string;
}
interface RawToolContentResource {
	type: "resource";
	resource: Record<string, unknown>;
}
type RawToolContent =
	| RawToolContentText
	| RawToolContentImage
	| RawToolContentResource
	| { type: string; [k: string]: unknown };

interface RawToolResult {
	content: RawToolContent[];
	structuredContent?: unknown;
	isError?: boolean;
}

function mapContent(
	items: RawToolContent[] | undefined,
): NormalizedContentItem[] {
	if (!items) return [];
	const out: NormalizedContentItem[] = [];
	for (const item of items) {
		if (
			item.type === "text" &&
			typeof (item as RawToolContentText).text === "string"
		) {
			out.push({ type: "text", text: (item as RawToolContentText).text });
		} else if (
			item.type === "image" &&
			typeof (item as RawToolContentImage).data === "string"
		) {
			out.push({
				type: "image",
				data: (item as RawToolContentImage).data,
				mimeType: (item as RawToolContentImage).mimeType,
			});
		} else if (
			item.type === "resource" &&
			(item as RawToolContentResource).resource
		) {
			out.push({
				type: "resource",
				resource: (item as RawToolContentResource).resource,
			});
		} else {
			// Fall back to text representation of unknown content kind.
			out.push({ type: "text", text: JSON.stringify(item) });
		}
	}
	return out;
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}
