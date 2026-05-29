import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./index.js", async () => {
	const actual =
		await vi.importActual<typeof import("./index.js")>("./index.js");
	return {
		...actual,
		startStdioServer: vi.fn().mockResolvedValue(undefined),
	};
});

const { main } = await import("./cli.js");

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

describe("cli > start with auth profiles", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cg-cli-start-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function p(name: string): string {
		return join(dir, name).replace(/\\/g, "/");
	}

	async function writeConfig(fields: {
		authProfilesPath?: string;
	}): Promise<string> {
		const configPath = join(dir, "gateway.config.yaml");
		const lines = [
			`toolsPath: ${p("tools.json")}`,
			`auditPath: ${p("audit.jsonl")}`,
		];
		if (fields.authProfilesPath) {
			lines.push(`authProfilesPath: ${fields.authProfilesPath}`);
		}
		lines.push("profiles:", "  coding: [coding]");
		await writeFile(configPath, `${lines.join("\n")}\n`, "utf8");
		return configPath;
	}

	async function writeTools(tools: unknown[]): Promise<void> {
		await writeFile(p("tools.json"), JSON.stringify({ tools }), "utf8");
	}

	function makeRestTool(opts: { authProfile?: string } = {}): unknown {
		return {
			name: "demo__rest",
			description: "rest demo",
			inputSchema: { type: "object" },
			tags: ["coding"],
			upstream: {
				type: "rest",
				method: "GET",
				url: "https://example.com/x",
			},
			concurrency: 1,
			timeoutMs: 1000,
			retryPolicy: "none",
			sideEffecting: false,
			...(opts.authProfile ? { authProfile: opts.authProfile } : {}),
		};
	}

	// `main(["start", ...])` hangs forever on success (keep-alive promise so MCP
	// clients staying connected work). Race against a short timeout to inspect
	// stderr after wiring completes.
	async function startUntilReady(
		argv: string[],
		stableMs = 100,
	): Promise<unknown> {
		let mainErr: unknown;
		const mainP = main(argv).catch((e) => {
			mainErr = e;
		});
		await Promise.race([
			mainP,
			new Promise<void>((r) => setTimeout(r, stableMs)),
		]);
		return mainErr;
	}

	it("throws when a tool declares authProfile but config has no authProfilesPath", async () => {
		const configPath = await writeConfig({});
		await writeTools([makeRestTool({ authProfile: "missing-profile" })]);
		await expect(
			main(["start", "--profile=coding", "--config", configPath]),
		).rejects.toThrow(/no authProfilesPath.*demo__rest.*missing-profile/s);
	});

	it("throws when a tool's authProfile is not declared in auth-profiles.yaml", async () => {
		const profilesPath = p("auth-profiles.yaml");
		const configPath = await writeConfig({ authProfilesPath: profilesPath });
		await writeFile(
			profilesPath,
			[
				"profiles:",
				"  other-profile:",
				"    type: bearer-static",
				"    token: hardcoded-token",
			].join("\n"),
			"utf8",
		);
		await writeTools([makeRestTool({ authProfile: "missing-profile" })]);
		await expect(
			main(["start", "--profile=coding", "--config", configPath]),
		).rejects.toThrow(/unknown auth profile.*demo__rest.*missing-profile/s);
	});

	it("wires the credential registry into the router on the happy path", async () => {
		const profilesPath = p("auth-profiles.yaml");
		const configPath = await writeConfig({ authProfilesPath: profilesPath });
		await writeFile(
			profilesPath,
			[
				"profiles:",
				"  test-profile:",
				"    type: bearer-static",
				"    token: hardcoded-token",
			].join("\n"),
			"utf8",
		);
		await writeTools([makeRestTool({ authProfile: "test-profile" })]);
		const err = await startUntilReady([
			"start",
			"--profile=coding",
			"--config",
			configPath,
		]);
		expect(err).toBeUndefined();
		const stderr = stderrCaptured.join("");
		expect(stderr).toContain("choda-gateway ready");
		expect(stderr).toContain("profile=coding tools=1");
	});

	it("warns when bearer-static token is plaintext (not via secret)", async () => {
		const profilesPath = p("auth-profiles.yaml");
		const configPath = await writeConfig({ authProfilesPath: profilesPath });
		await writeFile(
			profilesPath,
			[
				"profiles:",
				"  test-profile:",
				"    type: bearer-static",
				"    token: plaintext-not-via-secret",
			].join("\n"),
			"utf8",
		);
		await writeTools([makeRestTool({ authProfile: "test-profile" })]);
		const err = await startUntilReady([
			"start",
			"--profile=coding",
			"--config",
			configPath,
		]);
		expect(err).toBeUndefined();
		const stderr = stderrCaptured.join("");
		expect(stderr).toMatch(/warn:.*test-profile.*token.*plaintext/);
	});
});
