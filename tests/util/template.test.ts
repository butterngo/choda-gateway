import { describe, expect, it } from "vitest";
import { TemplateError, resolveTemplate } from "../../src/util/template.js";

describe("resolveTemplate", () => {
	it("resolves nested {{input.x}} inside an object", () => {
		const out = resolveTemplate(
			{ a: { b: "{{input.x}}" } },
			{ input: { x: "1" } },
		);
		expect(out).toEqual({ a: { b: "1" } });
	});

	it("resolves {{secrets.NAME}}", () => {
		const out = resolveTemplate(
			{ token: "Bearer {{secrets.LINEAR}}" },
			{ secrets: { LINEAR: "lin_abc" } },
		);
		expect(out).toEqual({ token: "Bearer lin_abc" });
	});

	it("walks arrays", () => {
		const out = resolveTemplate(["a={{input.a}}", "b={{input.b}}"], {
			input: { a: "1", b: "2" },
		});
		expect(out).toEqual(["a=1", "b=2"]);
	});

	it("throws TemplateError with the placeholder path when input field is missing", () => {
		expect(() => resolveTemplate("{{input.nope}}", { input: {} })).toThrow(
			TemplateError,
		);
		try {
			resolveTemplate("{{input.nope}}", { input: {} });
		} catch (e) {
			expect((e as TemplateError).placeholderPath).toBe("input.nope");
		}
	});

	it("throws when secret name is unknown", () => {
		expect(() =>
			resolveTemplate("{{secrets.MISSING}}", { secrets: {} }),
		).toThrow(/unknown secret: MISSING/);
	});

	it("throws on unknown placeholder root", () => {
		expect(() => resolveTemplate("{{env.HOME}}", {})).toThrow(
			/unknown placeholder root/,
		);
	});

	it("returns non-string scalars unchanged", () => {
		expect(resolveTemplate(42, {})).toBe(42);
		expect(resolveTemplate(null, {})).toBe(null);
		expect(resolveTemplate(true, {})).toBe(true);
	});

	it("resolves deep input paths", () => {
		const out = resolveTemplate("hi {{input.user.name}}", {
			input: { user: { name: "vu" } },
		});
		expect(out).toBe("hi vu");
	});
});
