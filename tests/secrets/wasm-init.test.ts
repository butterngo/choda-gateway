import { performance } from "node:perf_hooks";
import sodium from "libsodium-wrappers-sumo";
import { describe, expect, it } from "vitest";

describe("libsodium WASM init time", () => {
	it("await sodium.ready completes well under the 500ms budget", async () => {
		// sodium.ready is idempotent within a module, but since this is the first
		// (and only) place we await it inside this test file, the measurement
		// captures the first-init cost. Subsequent tests in this file pay zero.
		const t0 = performance.now();
		await sodium.ready;
		const elapsed = performance.now() - t0;

		// Spike-5 measured ~10ms. Budget keeps a healthy margin for CI flake.
		expect(elapsed).toBeLessThan(500);
	});
});
