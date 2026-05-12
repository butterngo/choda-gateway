import { describe, expect, it } from "vitest";
import { loadToolsManifest } from "../src/manifest/loader.js";

describe("repo smoke", () => {
	it("loads the committed tools.example.json via the production manifest loader", async () => {
		const manifest = await loadToolsManifest("tools.example.json");
		expect(manifest.tools.length).toBeGreaterThan(0);
		// Every tool has the ADR-005 namespace__action shape.
		for (const tool of manifest.tools) {
			expect(tool.name).toMatch(
				/^[a-z0-9][a-z0-9_-]*?__[a-z0-9][a-z0-9_]*[a-z0-9]$/,
			);
		}
	});
});
