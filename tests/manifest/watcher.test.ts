import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManifestWatcher } from "../../src/manifest/watcher.js";
import { makeManifest, makeMcpTool } from "./fixtures.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "manifest-watcher-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeConfigPair(): Promise<string> {
	const toolsPath = join(dir, "tools.json");
	const configPath = join(dir, "gateway.config.yaml");
	await writeFile(
		toolsPath,
		JSON.stringify(makeManifest([makeMcpTool()])),
		"utf8",
	);
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
	return configPath;
}

describe("createManifestWatcher", () => {
	it("reload() emits 'reload' with parsed manifest + config", async () => {
		const configPath = await writeConfigPair();
		const { watcher, reload, dispose } = createManifestWatcher({
			configPath,
			// Pass undefined to skip signal binding — keeps test cross-platform.
			signal: undefined as unknown as NodeJS.Signals,
		});

		const reloadEvent = new Promise<unknown>((resolve, reject) => {
			watcher.once("reload", resolve);
			watcher.once("error", reject);
		});

		await reload();
		const payload = (await reloadEvent) as { manifest: { tools: unknown[] } };
		expect(payload.manifest.tools).toHaveLength(1);

		dispose();
	});

	it("reload() emits 'error' when manifest invalid", async () => {
		const configPath = await writeConfigPair();
		// Corrupt the tools file
		await writeFile(join(dir, "tools.json"), "{ broken", "utf8");

		const { watcher, reload, dispose } = createManifestWatcher({
			configPath,
			signal: undefined as unknown as NodeJS.Signals,
		});

		const errorEvent = new Promise<Error>((resolve) => {
			watcher.once("error", resolve);
		});

		await reload();
		const err = await errorEvent;
		expect(err.message).toMatch(/malformed JSON/);

		dispose();
	});
});
