import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

let stdoutWrite: ReturnType<typeof vi.spyOn>;
let stderrWrite: ReturnType<typeof vi.spyOn>;
let stdoutCaptured: string[];
let stderrCaptured: string[];

beforeEach(() => {
	stdoutCaptured = [];
	stderrCaptured = [];
	stdoutWrite = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk) => {
			stdoutCaptured.push(
				typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
			);
			return true;
		});
	stderrWrite = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk) => {
			stderrCaptured.push(
				typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
			);
			return true;
		});
});

afterEach(() => {
	stdoutWrite.mockRestore();
	stderrWrite.mockRestore();
});

describe("cli", () => {
	it("prints help for --help", async () => {
		await main(["--help"]);
		const out = stdoutCaptured.join("");
		expect(out).toContain("choda-gateway");
		expect(out).toContain("Usage:");
		expect(out).toContain("choda-gateway start");
		expect(out).toContain("choda-gateway secrets");
		expect(out).toContain("GATEWAY_SECRETS_PASSWORD");
	});

	it("prints help when no positionals given", async () => {
		await main([]);
		expect(stdoutCaptured.join("")).toContain("Usage:");
	});

	it("`tools list` prints tools from the example manifest", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cg-cli-"));
		try {
			const configPath = join(dir, "gateway.config.yaml");
			const toolsPath = join(dir, "tools.json");
			await writeFile(
				configPath,
				`toolsPath: ${toolsPath.replace(/\\/g, "/")}\nauditPath: ${join(dir, "audit.jsonl").replace(/\\/g, "/")}\nprofiles:\n  coding: [coding]\n`,
				"utf8",
			);
			await writeFile(
				toolsPath,
				JSON.stringify({
					tools: [
						{
							name: "demo__echo",
							description: "echo",
							inputSchema: { type: "object" },
							tags: ["coding"],
							upstream: {
								type: "cli",
								command: "node",
								args: ["-e", "console.log('x')"],
							},
							concurrency: 1,
							timeoutMs: 1000,
							retryPolicy: "none",
							sideEffecting: false,
						},
					],
				}),
				"utf8",
			);
			await main(["tools", "list", "--config", configPath]);
			const out = stdoutCaptured.join("");
			expect(out).toMatch(/^demo__echo\t/m);
			expect(out).toContain("cli");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects unknown command", async () => {
		await expect(main(["wat"])).rejects.toThrow(/unknown command/);
	});

	it("rejects unknown secrets subcommand", async () => {
		await expect(main(["secrets", "wat"])).rejects.toThrow(
			/unknown secrets sub/,
		);
	});
});
