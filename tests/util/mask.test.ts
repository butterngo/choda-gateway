import { describe, expect, it } from "vitest";
import { maskJson, maskString } from "../../src/util/mask.js";

describe("maskString", () => {
	it("replaces a single occurrence with ***", () => {
		expect(maskString("token=abc123 ok", { values: ["abc123"] })).toBe(
			"token=*** ok",
		);
	});

	it("replaces multiple occurrences", () => {
		expect(maskString("abc abc abc", { values: ["abc"] })).toBe("*** *** ***");
	});

	it("longest match first prevents partial overlap", () => {
		// Without longest-first, masking 'foo' before 'foobar' would leave '***bar'.
		expect(maskString("foobar baz", { values: ["foo", "foobar"] })).toBe(
			"*** baz",
		);
	});

	it("skips empty + whitespace-only values to avoid pathological match", () => {
		expect(maskString("anything", { values: ["", "   "] })).toBe("anything");
	});

	it("leaves the input untouched when no value matches", () => {
		expect(maskString("public text", { values: ["secret"] })).toBe(
			"public text",
		);
	});
});

describe("maskJson", () => {
	it("walks nested objects + arrays and masks string leaves only", () => {
		const input = {
			headers: { Authorization: "Bearer abc123" },
			items: ["abc123", { nested: "abc123-tail" }],
			count: 42,
			flag: true,
		};
		const out = maskJson(input, { values: ["abc123"] }) as typeof input;
		expect(out.headers.Authorization).toBe("Bearer ***");
		expect(out.items[0]).toBe("***");
		expect((out.items[1] as { nested: string }).nested).toBe("***-tail");
		expect(out.count).toBe(42);
		expect(out.flag).toBe(true);
	});

	it("returns the input untouched when values is empty", () => {
		const input = { a: "x" };
		expect(maskJson(input, { values: [] })).toEqual(input);
	});
});
