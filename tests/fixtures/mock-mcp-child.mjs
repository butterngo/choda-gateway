#!/usr/bin/env node
// Mock MCP child server for mcp-adapter tests.
// Exposes 4 tools:
//   __echo {message} → returns text "echo: <message>" + structuredContent {message}
//   __slow {ms}      → waits N ms then returns "slow-done"
//   __crash          → calls setImmediate(process.exit(101)) — exits AFTER replying
//   __fail           → returns isError=true with text "intentional fail"
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{ name: "mock-mcp-child", version: "0.0.0" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "__echo",
			description: "echo back a message",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
			},
		},
		{
			name: "__slow",
			description: "wait N ms then return",
			inputSchema: {
				type: "object",
				properties: { ms: { type: "number" } },
				required: ["ms"],
			},
		},
		{
			name: "__crash",
			description: "exit(101) after replying",
			inputSchema: { type: "object" },
		},
		{
			name: "__fail",
			description: "return isError=true",
			inputSchema: { type: "object" },
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const args = req.params.arguments ?? {};
	switch (req.params.name) {
		case "__echo": {
			const text = `echo: ${args.message ?? ""}`;
			return {
				content: [{ type: "text", text }],
				structuredContent: { message: args.message ?? null },
			};
		}
		case "__slow": {
			const ms = Number(args.ms ?? 100);
			await new Promise((resolve) => setTimeout(resolve, ms));
			return { content: [{ type: "text", text: "slow-done" }] };
		}
		case "__crash": {
			setImmediate(() => process.exit(101));
			return { content: [{ type: "text", text: "about-to-crash" }] };
		}
		case "__fail": {
			return {
				content: [{ type: "text", text: "intentional fail" }],
				isError: true,
			};
		}
		default:
			throw new Error(`unknown tool: ${req.params.name}`);
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("mock-mcp-child ready\n");
