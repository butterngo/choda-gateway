import { describe, expect, it } from "vitest";
import {
	createProvider,
	createProviderRegistry,
} from "../../../src/auth/providers/factory.js";
import { AuthProfileError } from "../../../src/auth/types.js";

describe("createProvider — dispatch", () => {
	it("dispatches bearer-static", () => {
		const p = createProvider({ type: "bearer-static", token: "t" });
		expect(p.type).toBe("bearer-static");
	});

	it("dispatches api-key", () => {
		const p = createProvider({
			type: "api-key",
			location: "header",
			name: "X",
			value: "y",
		});
		expect(p.type).toBe("api-key");
	});

	it("unsupported type -> AuthProfileError with the profile name", () => {
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types
			createProvider({ type: "saml-magic" } as any, "magic-profile"),
		).toThrow(AuthProfileError);
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing types
			createProvider({ type: "saml-magic" } as any, "magic-profile"),
		).toThrow(/saml-magic/);
	});

	it("not-yet-implemented providers (oauth2-cc/cookie-jar/exec-script) throw until their task lands", () => {
		expect(() =>
			createProvider({
				type: "oauth2-cc",
				tokenUrl: "https://x/t",
				clientId: "a",
				clientSecret: "b",
				clientAuth: "basic",
			}),
		).toThrow(/oauth2-cc/);
	});
});

describe("createProviderRegistry", () => {
	it("builds a Map<name, CredentialProvider> from a profiles Map", () => {
		const profiles = new Map([
			["alpha", { type: "bearer-static", token: "t" } as const],
			[
				"beta",
				{
					type: "api-key",
					location: "header",
					name: "X",
					value: "y",
				} as const,
			],
		]);
		const reg = createProviderRegistry(profiles);
		expect(reg.size).toBe(2);
		expect(reg.get("alpha")?.type).toBe("bearer-static");
		expect(reg.get("beta")?.type).toBe("api-key");
	});
});
