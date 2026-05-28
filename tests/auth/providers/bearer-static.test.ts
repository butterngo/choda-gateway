import { describe, expect, it } from "vitest";
import { createBearerStaticProvider } from "../../../src/auth/providers/bearer-static.js";

describe("bearer-static provider", () => {
	it("emits Authorization: Bearer <token>", async () => {
		const provider = createBearerStaticProvider({
			type: "bearer-static",
			token: "abc.def.ghi",
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth).toEqual({ headers: { Authorization: "Bearer abc.def.ghi" } });
	});

	it("returns a fresh headers object on each call (no mutation leak)", async () => {
		const provider = createBearerStaticProvider({
			type: "bearer-static",
			token: "tok-1",
		});
		const a = await provider.resolve({ toolName: "t" });
		a.headers["X-Bad"] = "leaked";
		const b = await provider.resolve({ toolName: "t" });
		expect(b.headers["X-Bad"]).toBeUndefined();
		expect(b.headers.Authorization).toBe("Bearer tok-1");
	});

	it("type discriminator is set", () => {
		const provider = createBearerStaticProvider({
			type: "bearer-static",
			token: "x",
		});
		expect(provider.type).toBe("bearer-static");
	});
});
