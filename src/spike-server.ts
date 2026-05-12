import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const SERVER_NAME = "choda-gateway-spike";
const SERVER_VERSION = "0.0.0-spike";
const TOOL_NAME = "gateway__ping";

const HANDSHAKE_LOG = resolve(
	process.env.SPIKE_HANDSHAKE_LOG ?? "spike-handshake.log",
);

function ensureLogFile(): void {
	try {
		mkdirSync(dirname(HANDSHAKE_LOG), { recursive: true });
	} catch {}
}

function logHandshake(direction: "in" | "out", payload: unknown): void {
	try {
		const line = `${new Date().toISOString()} ${direction === "in" ? "<<<" : ">>>"} ${JSON.stringify(payload)}\n`;
		appendFileSync(HANDSHAKE_LOG, line);
	} catch (err) {
		process.stderr.write(
			`[spike] handshake log write failed: ${String(err)}\n`,
		);
	}
}

const PingInput = z.object({ message: z.string().optional() });

function buildServer(): Server {
	const server = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: TOOL_NAME,
				description:
					"Hello-world ping tool for choda-gateway MCP spike. Echoes optional message with timestamp.",
				inputSchema: {
					type: "object",
					properties: {
						message: {
							type: "string",
							description: "Optional message to echo back.",
						},
					},
					additionalProperties: false,
				},
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		if (req.params.name !== TOOL_NAME) {
			throw new Error(`unknown tool: ${req.params.name}`);
		}
		const parsed = PingInput.safeParse(req.params.arguments ?? {});
		if (!parsed.success) {
			throw new Error(`invalid arguments: ${parsed.error.message}`);
		}
		const result = {
			ok: true as const,
			ts: new Date().toISOString(),
			...(parsed.data.message !== undefined
				? { echo: parsed.data.message }
				: {}),
		};
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			structuredContent: result,
		};
	});

	return server;
}

async function runSelftest(): Promise<void> {
	const server = buildServer();
	void server;
	process.stderr.write("MCP server ready (selftest)\n");
	process.exit(0);
}

async function runStdio(): Promise<void> {
	ensureLogFile();
	const server = buildServer();
	const transport = new StdioServerTransport();

	const origSend = transport.send.bind(transport);
	transport.send = async (msg) => {
		logHandshake("out", msg);
		return origSend(msg);
	};

	await server.connect(transport);

	const sdkOnMessage = transport.onmessage;
	transport.onmessage = (msg) => {
		logHandshake("in", msg);
		sdkOnMessage?.(msg);
	};

	process.stderr.write("MCP server ready\n");
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
	runSelftest().catch((err) => {
		process.stderr.write(`[spike] selftest failed: ${String(err)}\n`);
		process.exit(1);
	});
} else {
	runStdio().catch((err) => {
		process.stderr.write(`[spike] stdio start failed: ${String(err)}\n`);
		process.exit(1);
	});
}
