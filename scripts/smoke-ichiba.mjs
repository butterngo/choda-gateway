// One-shot smoke test for the ichiba cookie-jar tools.
// Spawns a fresh gateway (profile=ichiba), calls one tool, prints the result.
//
// Run from the repo root, in a shell where GATEWAY_SECRETS_PASSWORD is set:
//   node scripts/smoke-ichiba.mjs                  # defaults to ichiba__userinfo
//   node scripts/smoke-ichiba.mjs ichiba__products_list
//
// The cookie comes from sensitive_information/ichiba_cookies.txt — with only
// comments in that file you'll see HTTP 401 (proves wiring); paste a real
// session cookie to see 200 + JSON.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const toolName = process.argv[2] ?? "ichiba__userinfo";

const transport = new StdioClientTransport({
	command: "node",
	args: ["dist/cli.js", "start", "--profile=ichiba"],
	env: { ...process.env }, // propagate GATEWAY_SECRETS_PASSWORD to the child
});

const client = new Client(
	{ name: "ichiba-smoke", version: "0.0.0" },
	{ capabilities: {} },
);

try {
	await client.connect(transport);
	console.error(`> calling ${toolName} ...`);
	const res = await client.callTool({ name: toolName, arguments: {} });
	console.log(JSON.stringify(res, null, 2));
	process.exitCode = res.isError ? 1 : 0;
} finally {
	await client.close();
}
