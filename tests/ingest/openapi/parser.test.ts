import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../../../src/ingest/openapi/parser.js";
import { OpenApiParseError } from "../../../src/ingest/openapi/types.js";

const here = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const fixture = (name: string) => join(here, name);

describe("parseSpec — happy path 3.0", () => {
	it("loads petstore + resolves $refs in schemas", async () => {
		const spec = await parseSpec(fixture("petstore-3.0.yaml"));
		expect(spec.info.title).toBe("Petstore");
		expect(spec.info.openapiVersion).toBe("3.0.3");
		expect(spec.info.defaultBaseUrl).toBe("https://api.petstore.example/v1");
		expect(spec.operations.map((o) => o.operationId)).toEqual([
			"listPets",
			"createPet",
			"getPet",
		]);
		expect(spec.warnings).toEqual([]);

		const listPets = spec.operations[0];
		expect(listPets.method).toBe("GET");
		expect(listPets.path).toBe("/pets");
		expect(listPets.parameters).toEqual([
			{
				name: "limit",
				in: "query",
				required: false,
				description: undefined,
				schema: {
					type: "integer",
					minimum: 1,
					maximum: 100,
				},
			},
		]);
		expect(listPets.tags).toEqual(["pet"]);

		const createPet = spec.operations[1];
		expect(createPet.requestBody?.required).toBe(true);
		// $ref to NewPet resolved
		expect(createPet.requestBody?.schema).toMatchObject({
			type: "object",
			required: ["name"],
			properties: { name: { type: "string" } },
		});
		// x-choda-* extension preserved via rawNode
		expect(
			(createPet.rawNode as Record<string, unknown>)["x-choda-timeout-ms"],
		).toBe(5000);

		const getPet = spec.operations[2];
		// path-level parameter inherited
		expect(getPet.parameters).toEqual([
			{
				name: "petId",
				in: "path",
				required: true,
				description: undefined,
				schema: { type: "integer" },
			},
		]);

		expect(getPet.securitySchemes?.bearerAuth).toBeDefined();
	});
});

describe("parseSpec — minimal 3.1", () => {
	it("loads + warns on webhooks", async () => {
		const spec = await parseSpec(fixture("minimal-3.1.yaml"));
		expect(spec.info.openapiVersion).toBe("3.1.0");
		expect(spec.operations).toHaveLength(1);
		expect(spec.operations[0].operationId).toBe("ping");
		expect(spec.warnings.some((w) => /webhooks ignored/.test(w))).toBe(true);
	});
});

describe("parseSpec — unsupported pieces emit warnings + skip", () => {
	it("multipart requestBody → skip; cookie param → drop param only; remote $ref → skip op; callbacks → skip op", async () => {
		const spec = await parseSpec(fixture("mixed-unsupported.yaml"));
		const ids = spec.operations.map((o) => o.operationId);
		// "good" + "cookieParam" (param dropped, op kept)
		expect(ids).toContain("good");
		expect(ids).toContain("cookieParam");
		expect(ids).not.toContain("upload"); // multipart
		expect(ids).not.toContain("remote"); // remote $ref
		expect(ids).not.toContain("cbop"); // callbacks

		expect(spec.warnings.some((w) => /multipart/.test(w))).toBe(true);
		expect(spec.warnings.some((w) => /remote \$ref/.test(w))).toBe(true);
		expect(spec.warnings.some((w) => /callbacks/.test(w))).toBe(true);
		expect(spec.warnings.some((w) => /cookie/.test(w))).toBe(true);

		// cookieParam should have an empty params list (cookie param dropped)
		const cookieOp = spec.operations.find(
			(o) => o.operationId === "cookieParam",
		);
		expect(cookieOp?.parameters).toEqual([]);
	});
});

describe("parseSpec — error paths", () => {
	it("rejects swagger 2.0", async () => {
		await expect(
			parseSpecText(
				`{ "swagger": "2.0", "info": { "title": "x", "version": "1" }, "paths": {} }`,
				".json",
			),
		).rejects.toThrow(/OpenAPI 2\.0/);
	});

	it("rejects spec without openapi field", async () => {
		await expect(
			parseSpecText(
				`{ "info": { "title": "x", "version": "1" }, "paths": {} }`,
				".json",
			),
		).rejects.toThrow(/missing `openapi`/);
	});

	it("rejects unsupported version", async () => {
		await expect(
			parseSpecText(
				`{ "openapi": "4.0.0", "info": { "title": "x", "version": "1" }, "paths": {} }`,
				".json",
			),
		).rejects.toThrow(/unsupported OpenAPI version/);
	});

	it("missing file throws OpenApiParseError", async () => {
		await expect(parseSpec(fixture("no-such.yaml"))).rejects.toThrow(
			OpenApiParseError,
		);
	});
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

async function parseSpecText(text: string, ext: string) {
	const dir = await mkdtemp(join(tmpdir(), "openapi-"));
	try {
		const path = join(dir, `spec${ext}`);
		await writeFile(path, text, "utf8");
		return await parseSpec(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
