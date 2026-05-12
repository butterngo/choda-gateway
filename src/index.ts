import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Router } from "./router.js";
import { InputValidationError, ToolNotFoundError } from "./router.js";

export interface BuildServerOptions {
	router: Router;
	serverName?: string;
	serverVersion?: string;
}

export function buildMcpServer(opts: BuildServerOptions): Server {
	const server = new Server(
		{
			name: opts.serverName ?? "choda-gateway",
			version: opts.serverVersion ?? "0.1.0",
		},
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: opts.router.listTools().map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const toolName = req.params.name;
		const input = (req.params.arguments ?? {}) as Record<string, unknown>;
		try {
			const result = await opts.router.call(toolName, input);
			const out: {
				content: typeof result.content;
				structuredContent?: unknown;
				isError?: boolean;
			} = { content: result.content };
			if (result.structuredContent !== undefined) {
				out.structuredContent = result.structuredContent;
			}
			if (result.isError) out.isError = true;
			return out;
		} catch (err) {
			if (err instanceof ToolNotFoundError) {
				return {
					content: [{ type: "text", text: err.message }],
					isError: true,
				};
			}
			if (err instanceof InputValidationError) {
				return {
					content: [{ type: "text", text: err.message }],
					isError: true,
				};
			}
			throw err;
		}
	});

	return server;
}

export async function startStdioServer(server: Server): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
