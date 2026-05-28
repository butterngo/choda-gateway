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

	it("dispatches oauth2-cc", () => {
		const p = createProvider({
			type: "oauth2-cc",
			tokenUrl: "https://x/t",
			clientId: "a",
			clientSecret: "b",
			clientAuth: "basic",
		});
		expect(p.type).toBe("oauth2-cc");
	});

	it("dispatches cookie-jar", () => {
		const p = createProvider({
			type: "cookie-jar",
			cookieFile: "/tmp/c",
			forwardHeaders: ["cookie"],
		});
		expect(p.type).toBe("cookie-jar");
	});

	it("dispatches exec-script", () => {
		const p = createProvider({
			type: "exec-script",
			command: ["true"],
			cacheTtlSeconds: 60,
			parseOutputAs: "raw",
			timeoutMs: 30_000,
		});
		expect(p.type).toBe("exec-script");
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
