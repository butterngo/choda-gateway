import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../../../src/ingest/openapi/parser.js";
import { transformSpec } from "../../../src/ingest/openapi/transform.js";
import type { ParsedSpec } from "../../../src/ingest/openapi/types.js";

const here = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const fixture = (name: string) => join(here, name);

async function loadPetstore(): Promise<ParsedSpec> {
	return await parseSpec(fixture("petstore-3.0.yaml"));
}

describe("transformSpec — naming", () => {
	it("uses normalised operationId for tool name", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, {
			group: "petstore",
			authProfile: "petstore-key",
		});
		expect(tools.map((t) => t.name)).toEqual([
			"petstore__list_pets",
			"petstore__create_pet",
			"petstore__get_pet",
		]);
	});

	it("derives name from verb + path when operationId is missing", () => {
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x.example",
			},
			operations: [
				{
					method: "GET",
					path: "/orders/{orderId}/items",
					tags: [],
					parameters: [
						{
							name: "orderId",
							in: "path",
							required: true,
							schema: { type: "string" },
						},
					],
					responses: {},
					rawNode: {},
				},
			],
			warnings: [],
		};
		const { tools } = transformSpec(spec, { group: "shop" });
		expect(tools[0].name).toBe("shop__get_orders_orderid_items");
	});

	it("rejects an invalid group", () => {
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x",
			},
			operations: [],
			warnings: [],
		};
		expect(() => transformSpec(spec, { group: "Bad_Group" })).toThrow(/^group/);
	});

	it("throws on tool-name collision (same operationId on two operations)", () => {
		const op = (method: "GET" | "POST", operationId: string, path: string) => ({
			method,
			path,
			operationId,
			tags: [],
			parameters: [],
			responses: {},
			rawNode: {},
		});
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x",
			},
			operations: [op("GET", "list", "/a"), op("POST", "list", "/b")],
			warnings: [],
		};
		expect(() => transformSpec(spec, { group: "g" })).toThrow(
			/tool name collision/,
		);
	});
});

describe("transformSpec — tags + execution policy", () => {
	it("merges OpenAPI tags with the group; dedups", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, { group: "petstore" });
		// Each op has tag "pet"; group also "petstore"
		for (const t of tools) {
			expect(t.tags).toEqual(["pet", "petstore"]);
		}
	});

	it("GET defaults: concurrency=8, retryPolicy=safe-idempotent, sideEffecting=false", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, { group: "p" });
		const get = tools.find((t) => t.name === "p__list_pets");
		expect(get?.concurrency).toBe(8);
		expect(get?.retryPolicy).toBe("safe-idempotent");
		expect(get?.sideEffecting).toBe(false);
	});

	it("POST defaults: concurrency=4, retryPolicy=none, sideEffecting=true", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, { group: "p" });
		const post = tools.find((t) => t.name === "p__create_pet");
		expect(post?.concurrency).toBe(4);
		expect(post?.retryPolicy).toBe("none");
		expect(post?.sideEffecting).toBe(true);
	});

	it("x-choda-timeout-ms overrides default 30000", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, { group: "p" });
		const post = tools.find((t) => t.name === "p__create_pet");
		// petstore-3.0.yaml sets x-choda-timeout-ms: 5000 on createPet
		expect(post?.timeoutMs).toBe(5000);
		const get = tools.find((t) => t.name === "p__list_pets");
		expect(get?.timeoutMs).toBe(30_000);
	});
});

describe("transformSpec — authProfile + x-choda-auth-profile override", () => {
	it("uses opts.authProfile by default", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, {
			group: "p",
			authProfile: "petstore-key",
		});
		for (const t of tools) {
			expect(t.authProfile).toBe("petstore-key");
		}
	});

	it("per-op x-choda-auth-profile overrides the global default", () => {
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x.example",
			},
			operations: [
				{
					method: "GET",
					path: "/a",
					operationId: "doA",
					tags: [],
					parameters: [],
					responses: {},
					rawNode: { "x-choda-auth-profile": "special-profile" },
				},
			],
			warnings: [],
		};
		const { tools } = transformSpec(spec, {
			group: "g",
			authProfile: "default-profile",
		});
		expect(tools[0].authProfile).toBe("special-profile");
	});

	it("no authProfile field when none provided + none in op", () => {
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x.example",
			},
			operations: [
				{
					method: "GET",
					path: "/a",
					operationId: "a",
					tags: [],
					parameters: [],
					responses: {},
					rawNode: {},
				},
			],
			warnings: [],
		};
		const { tools } = transformSpec(spec, { group: "g" });
		expect(tools[0].authProfile).toBeUndefined();
	});
});

describe("transformSpec — URL templating", () => {
	it("substitutes path params via {{input.X}}", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, {
			group: "p",
			baseUrl: "https://example.com/v1",
		});
		const get = tools.find((t) => t.name === "p__get_pet");
		const upstream = get?.upstream as { type: string; url: string };
		expect(upstream.url).toBe("https://example.com/v1/pets/{{input.petId}}");
	});

	it("appends required query params to URL", () => {
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x.example",
			},
			operations: [
				{
					method: "GET",
					path: "/search",
					operationId: "search",
					tags: [],
					parameters: [
						{
							name: "q",
							in: "query",
							required: true,
							schema: { type: "string" },
						},
						{
							name: "limit",
							in: "query",
							required: false,
							schema: { type: "integer" },
						},
					],
					responses: {},
					rawNode: {},
				},
			],
			warnings: [],
		};
		const { tools } = transformSpec(spec, { group: "g" });
		const u = tools[0].upstream as { type: string; url: string };
		expect(u.url).toBe("https://x.example/search?q={{input.q}}");
	});

	it("trims trailing slash from baseUrl", () => {
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x.example///",
			},
			operations: [
				{
					method: "GET",
					path: "/a",
					operationId: "a",
					tags: [],
					parameters: [],
					responses: {},
					rawNode: {},
				},
			],
			warnings: [],
		};
		const { tools } = transformSpec(spec, { group: "g" });
		const u = tools[0].upstream as { type: string; url: string };
		expect(u.url).toBe("https://x.example/a");
	});

	it("throws when no baseUrl + no servers", () => {
		const spec: ParsedSpec = {
			info: { title: "x", version: "1", openapiVersion: "3.0.0" },
			operations: [],
			warnings: [],
		};
		expect(() => transformSpec(spec, { group: "g" })).toThrow(/baseUrl/);
	});
});

describe("transformSpec — input schema synthesis", () => {
	it("path + query + header params land in inputSchema; path always required", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, { group: "p" });
		const get = tools.find((t) => t.name === "p__get_pet");
		const schema = get?.inputSchema as Record<string, unknown>;
		expect((schema.properties as Record<string, unknown>).petId).toEqual({
			type: "integer",
		});
		expect(schema.required).toEqual(["petId"]);
	});

	it("body properties flattened into top-level inputSchema", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, { group: "p" });
		const post = tools.find((t) => t.name === "p__create_pet");
		const schema = post?.inputSchema as Record<string, unknown>;
		const props = schema.properties as Record<string, unknown>;
		expect(props.name).toEqual({ type: "string" });
		expect(schema.required).toContain("name");
	});

	it("bodyTemplate synthesised from body top-level props (alphabetical, {{input.X}} placeholders)", async () => {
		const spec = await loadPetstore();
		const { tools } = transformSpec(spec, { group: "p" });
		const post = tools.find((t) => t.name === "p__create_pet");
		expect((post?.upstream as { bodyTemplate?: unknown }).bodyTemplate).toEqual(
			{ name: "{{input.name}}" },
		);
	});

	it("polymorphic schema beyond depth 3 → flattened to { type: object } with warning", () => {
		// schema with nested oneOf chain depth > 3
		const deeplyNested = {
			type: "object",
			properties: {
				a: {
					oneOf: [
						{
							oneOf: [
								{
									oneOf: [{ oneOf: [{ type: "string" }, { type: "number" }] }],
								},
							],
						},
					],
				},
			},
		};
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x",
			},
			operations: [
				{
					method: "POST",
					path: "/things",
					operationId: "thing",
					tags: [],
					parameters: [],
					requestBody: { required: true, schema: deeplyNested },
					responses: {},
					rawNode: {},
				},
			],
			warnings: [],
		};
		const { warnings } = transformSpec(spec, { group: "g" });
		expect(warnings.some((w) => /polymorphic/.test(w))).toBe(true);
	});
});

describe("transformSpec — description + deterministic output", () => {
	it("description uses summary; truncates to 300 chars", () => {
		const long = "x".repeat(500);
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x",
			},
			operations: [
				{
					method: "GET",
					path: "/a",
					operationId: "a",
					summary: long,
					tags: [],
					parameters: [],
					responses: {},
					rawNode: {},
				},
			],
			warnings: [],
		};
		const { tools } = transformSpec(spec, { group: "g" });
		expect(tools[0].description.length).toBeLessThanOrEqual(300);
	});

	it("description falls back to '<METHOD> <path>' when no summary/description", () => {
		const spec: ParsedSpec = {
			info: {
				title: "x",
				version: "1",
				openapiVersion: "3.0.0",
				defaultBaseUrl: "https://x",
			},
			operations: [
				{
					method: "GET",
					path: "/ping",
					operationId: "p",
					tags: [],
					parameters: [],
					responses: {},
					rawNode: {},
				},
			],
			warnings: [],
		};
		const { tools } = transformSpec(spec, { group: "g" });
		expect(tools[0].description).toBe("GET /ping");
	});

	it("output is byte-identical across runs (same input)", async () => {
		const spec = await loadPetstore();
		const a = JSON.stringify(
			transformSpec(spec, { group: "p", authProfile: "ap" }).tools,
		);
		const b = JSON.stringify(
			transformSpec(spec, { group: "p", authProfile: "ap" }).tools,
		);
		expect(a).toBe(b);
	});
});
