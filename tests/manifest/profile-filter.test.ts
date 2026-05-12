import { describe, expect, it } from "vitest";
import { ProfileError } from "../../src/manifest/errors.js";
import {
	filterToolsByProfile,
	resolveActiveProfile,
} from "../../src/manifest/profile-filter.js";
import type { GatewayConfig } from "../../src/manifest/types.js";
import { makeCliTool, makeMcpTool, makeRestTool } from "./fixtures.js";

const config: GatewayConfig = {
	toolsPath: "./tools.json",
	auditPath: "./audit.jsonl",
	profiles: {
		coding: ["coding", "planning"],
		ops: ["ops", "infra"],
		all: ["coding", "planning", "ops", "infra"],
	},
};

describe("resolveActiveProfile", () => {
	it("CLI flag wins over env var", () => {
		const p = resolveActiveProfile({
			cliFlag: "coding",
			env: { GATEWAY_PROFILE: "ops" },
			config,
		});
		expect(p.name).toBe("coding");
		expect(p.tags).toEqual(["coding", "planning"]);
	});

	it("falls back to env var when CLI flag absent", () => {
		const p = resolveActiveProfile({
			env: { GATEWAY_PROFILE: "ops" },
			config,
		});
		expect(p.name).toBe("ops");
	});

	it("throws when neither CLI nor env provided", () => {
		expect(() => resolveActiveProfile({ config })).toThrow(ProfileError);
	});

	it("throws when profile name not found in config", () => {
		expect(() => resolveActiveProfile({ cliFlag: "nope", config })).toThrow(
			/profile not found: nope/,
		);
	});
});

describe("filterToolsByProfile", () => {
	const mcp = makeMcpTool({
		name: "tasks__task_list",
		tags: ["coding", "planning"],
	});
	const rest = makeRestTool({
		name: "linear__issue_search",
		tags: ["planning"],
	});
	const cli = makeCliTool({ name: "gh__pr_list", tags: ["coding"] });
	const kube = makeCliTool({ name: "kubectl__pod_logs", tags: ["ops"] });

	it("full match: all tools share a tag with profile", () => {
		const tools = filterToolsByProfile([mcp, rest, cli], {
			name: "coding",
			tags: ["coding", "planning"],
		});
		expect(tools.map((t) => t.name)).toEqual([
			"tasks__task_list",
			"linear__issue_search",
			"gh__pr_list",
		]);
	});

	it("partial match: some tools share a tag", () => {
		const tools = filterToolsByProfile([mcp, rest, cli, kube], {
			name: "coding",
			tags: ["coding"],
		});
		// mcp (coding, planning) ∩ coding = match
		// rest (planning) ∩ coding = no
		// cli (coding) ∩ coding = match
		// kube (ops) ∩ coding = no
		expect(tools.map((t) => t.name)).toEqual([
			"tasks__task_list",
			"gh__pr_list",
		]);
	});

	it("no match: profile tags do not intersect any tool", () => {
		const tools = filterToolsByProfile([mcp, rest, cli], {
			name: "ops",
			tags: ["ops", "infra"],
		});
		expect(tools).toEqual([]);
	});

	it("preserves tool order from input", () => {
		const tools = filterToolsByProfile([cli, mcp, rest], {
			name: "all",
			tags: ["coding", "planning"],
		});
		expect(tools.map((t) => t.name)).toEqual([
			"gh__pr_list",
			"tasks__task_list",
			"linear__issue_search",
		]);
	});
});
