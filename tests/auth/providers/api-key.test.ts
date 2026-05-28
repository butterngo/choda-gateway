import { describe, expect, it } from "vitest";
import { createApiKeyProvider } from "../../../src/auth/providers/api-key.js";

describe("api-key provider", () => {
	it("emits a header when location=header", async () => {
		const provider = createApiKeyProvider({
			type: "api-key",
			location: "header",
			name: "X-API-Key",
			value: "key-1",
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth).toEqual({ headers: { "X-API-Key": "key-1" } });
		expect(auth.query).toBeUndefined();
	});

	it("emits a query param when location=query", async () => {
		const provider = createApiKeyProvider({
			type: "api-key",
			location: "query",
			name: "api_key",
			value: "key-2",
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers).toEqual({});
		expect(auth.query).toEqual({ api_key: "key-2" });
	});

	it("type discriminator is set", () => {
		const provider = createApiKeyProvider({
			type: "api-key",
			location: "header",
			name: "X",
			value: "y",
		});
		expect(provider.type).toBe("api-key");
	});
});
