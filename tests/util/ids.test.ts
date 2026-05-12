import { describe, expect, it } from "vitest";
import { generateCorrId } from "../../src/util/ids.js";

const CORR_REGEX = /^corr_[0-9A-HJKMNP-TV-Z]{26}$/;

describe("generateCorrId", () => {
	it("matches the audit-entry schema regex", () => {
		expect(generateCorrId()).toMatch(CORR_REGEX);
	});

	it("returns distinct ids on repeated calls", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateCorrId()));
		expect(ids.size).toBe(100);
	});

	it("ULID time prefix gives non-decreasing lex order across calls spread over time", async () => {
		const first = generateCorrId();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = generateCorrId();
		expect(second.localeCompare(first)).toBeGreaterThan(0);
	});
});
