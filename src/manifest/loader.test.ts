import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGatewayConfig } from "./loader.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "cg-loader-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("loadGatewayConfig", () => {
	it("returns resolvedAuthProfilesPath when authProfilesPath is set (relative)", async () => {
		const configPath = join(dir, "gateway.config.yaml");
		await writeFile(
			configPath,
			[
				"toolsPath: ./tools.json",
				"auditPath: ./audit.jsonl",
				"authProfilesPath: ./auth-profiles.yaml",
				"profiles:",
				"  coding: [coding]",
			].join("\n"),
			"utf8",
		);
		const loaded = await loadGatewayConfig(configPath);
		expect(loaded.resolvedAuthProfilesPath).toBe(
			resolvePath(dir, "auth-profiles.yaml"),
		);
	});

	it("returns resolvedAuthProfilesPath unchanged when authProfilesPath is absolute", async () => {
		const configPath = join(dir, "gateway.config.yaml");
		const absProfiles = resolvePath(dir, "custom", "profiles.yaml");
		await writeFile(
			configPath,
			[
				"toolsPath: ./tools.json",
				"auditPath: ./audit.jsonl",
				`authProfilesPath: ${absProfiles.replace(/\\/g, "/")}`,
				"profiles:",
				"  coding: [coding]",
			].join("\n"),
			"utf8",
		);
		const loaded = await loadGatewayConfig(configPath);
		expect(loaded.resolvedAuthProfilesPath).toBe(
			absProfiles.replace(/\\/g, "/"),
		);
	});

	it("returns undefined resolvedAuthProfilesPath when authProfilesPath is not set", async () => {
		const configPath = join(dir, "gateway.config.yaml");
		await writeFile(
			configPath,
			[
				"toolsPath: ./tools.json",
				"auditPath: ./audit.jsonl",
				"profiles:",
				"  coding: [coding]",
			].join("\n"),
			"utf8",
		);
		const loaded = await loadGatewayConfig(configPath);
		expect(loaded.resolvedAuthProfilesPath).toBeUndefined();
	});
});
