import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIngest } from "../../src/ingest/cli.js";

const here = fileURLToPath(new URL("./openapi/__fixtures__", import.meta.url));
const fixture = (name: string) => join(here, name);

let dir: string;
let stdoutLines: string[];
let stderrLines: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ingest-cli-"));
	stdoutLines = [];
	stderrLines = [];
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const captureOut = (s: string) => stdoutLines.push(s);
const captureErr = (s: string) => stderrLines.push(s);

describe("runIngest — write mode", () => {
	it("writes a fragment file for the petstore spec; echoes warnings", async () => {
		const outPath = join(dir, "petstore.json");
		const result = await runIngest({
			specPath: fixture("petstore-3.0.yaml"),
			group: "petstore",
			authProfile: "petstore-key",
			outPath,
			stdout: captureOut,
			stderr: captureErr,
		});
		expect(result.exitCode).toBe(0);
		expect(result.written).toBe(true);
		expect(result.toolCount).toBe(3);
		expect(stdoutLines.some((l) => /wrote 3 tool/.test(l))).toBe(true);

		const fragment = JSON.parse(await readFile(outPath, "utf8"));
		expect(fragment.tools).toHaveLength(3);
		expect(fragment.tools.map((t: { name: string }) => t.name)).toEqual([
			"petstore__list_pets",
			"petstore__create_pet",
			"petstore__get_pet",
		]);
		for (const t of fragment.tools) {
			expect(t.authProfile).toBe("petstore-key");
		}
	});

	it("output is pretty-printed (2-space indent) + ends with newline", async () => {
		const outPath = join(dir, "petstore.json");
		await runIngest({
			specPath: fixture("petstore-3.0.yaml"),
			group: "petstore",
			outPath,
			stdout: captureOut,
			stderr: captureErr,
		});
		const text = await readFile(outPath, "utf8");
		expect(text.startsWith("{\n  ")).toBe(true);
		expect(text.endsWith("\n")).toBe(true);
	});

	it("default outPath = tools/<group>.<basename>.json", async () => {
		const result = await runIngest({
			specPath: fixture("petstore-3.0.yaml"),
			group: "petstore",
			outPath: join(dir, "tools/petstore.petstore-3.0.json"),
			stdout: captureOut,
			stderr: captureErr,
		});
		expect(result.outPath).toContain("tools");
	});

	it("warns when --auth-profile is not in declared profiles (no error)", async () => {
		const profiles = join(dir, "auth-profiles.yaml");
		await writeFile(
			profiles,
			"profiles:\n  declared:\n    type: bearer-static\n    token: t\n",
			"utf8",
		);
		const outPath = join(dir, "p.json");
		const result = await runIngest({
			specPath: fixture("petstore-3.0.yaml"),
			group: "p",
			authProfile: "not-declared",
			authProfilesPath: profiles,
			outPath,
			stdout: captureOut,
			stderr: captureErr,
		});
		expect(result.exitCode).toBe(0);
		expect(
			stderrLines.some((l) => /not \(yet\) declared in auth-profiles/.test(l)),
		).toBe(true);
	});
});

describe("runIngest — --check mode", () => {
	it("up-to-date fragment: exit 0, nothing written", async () => {
		const outPath = join(dir, "p.json");
		// first write
		await runIngest({
			specPath: fixture("petstore-3.0.yaml"),
			group: "petstore",
			authProfile: "petstore-key",
			outPath,
			stdout: captureOut,
			stderr: captureErr,
		});
		stdoutLines = [];
		stderrLines = [];
		// then check
		const result = await runIngest({
			specPath: fixture("petstore-3.0.yaml"),
			group: "petstore",
			authProfile: "petstore-key",
			outPath,
			check: true,
			stdout: captureOut,
			stderr: captureErr,
		});
		expect(result.exitCode).toBe(0);
		expect(result.written).toBe(false);
		expect(stdoutLines.some((l) => /up-to-date/.test(l))).toBe(true);
	});

	it("drift: exit 1 + diff summary on stderr; no write", async () => {
		const outPath = join(dir, "p.json");
		// write a stale fragment first
		await writeFile(
			outPath,
			JSON.stringify(
				{
					tools: [
						{
							name: "petstore__list_pets",
							description: "STALE",
							inputSchema: { type: "object" },
							tags: ["petstore"],
							upstream: { type: "rest", method: "GET", url: "http://x" },
							concurrency: 1,
							timeoutMs: 1,
							retryPolicy: "none",
							sideEffecting: false,
						},
					],
				},
				null,
				2,
			),
			"utf8",
		);
		const result = await runIngest({
			specPath: fixture("petstore-3.0.yaml"),
			group: "petstore",
			outPath,
			check: true,
			stdout: captureOut,
			stderr: captureErr,
		});
		expect(result.exitCode).toBe(1);
		expect(result.written).toBe(false);
		expect(stderrLines.join("")).toMatch(/drift:/);
	});

	it("missing fragment in check mode → exit 1", async () => {
		const result = await runIngest({
			specPath: fixture("petstore-3.0.yaml"),
			group: "petstore",
			outPath: join(dir, "missing.json"),
			check: true,
			stdout: captureOut,
			stderr: captureErr,
		});
		expect(result.exitCode).toBe(1);
		expect(stderrLines.join("")).toMatch(/does not exist/);
	});
});
