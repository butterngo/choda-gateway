import { describe, expect, it, vi } from "vitest";
import { createOAuth2CcProvider } from "../../../src/auth/providers/oauth2-cc.js";
import { AuthResolveError } from "../../../src/auth/types.js";

interface FakeFetchOptions {
	status?: number;
	body?: unknown;
	bodyText?: string;
	captureRequests?: Array<{
		url: string;
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	}>;
	delayMs?: number;
}

function fakeFetch(opts: FakeFetchOptions) {
	const fn = vi.fn(async (url: string, init?: RequestInit) => {
		if (opts.captureRequests) {
			opts.captureRequests.push({
				url,
				method: init?.method,
				headers: init?.headers as Record<string, string>,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
		}
		if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
		const text =
			opts.bodyText !== undefined ? opts.bodyText : JSON.stringify(opts.body);
		return {
			ok: (opts.status ?? 200) < 400,
			status: opts.status ?? 200,
			async text() {
				return text;
			},
		} as unknown as Response;
	});
	// undici-style fetch type
	return fn as unknown as typeof import("undici").fetch;
}

const PROFILE = {
	type: "oauth2-cc" as const,
	tokenUrl: "https://auth.example/token",
	clientId: "cid-1",
	clientSecret: "csec-2",
	clientAuth: "basic" as const,
};

describe("oauth2-cc provider — happy path", () => {
	it("POSTs client_credentials grant + returns Bearer header", async () => {
		const requests: Array<{
			url: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		}> = [];
		const provider = createOAuth2CcProvider(PROFILE, {
			fetchImpl: fakeFetch({
				body: { access_token: "tok-A", expires_in: 3600 },
				captureRequests: requests,
			}),
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth).toEqual({ headers: { Authorization: "Bearer tok-A" } });
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://auth.example/token");
		expect(requests[0].method).toBe("POST");
		expect(requests[0].headers?.["content-type"]).toBe(
			"application/x-www-form-urlencoded",
		);
		const expected = `Basic ${Buffer.from("cid-1:csec-2").toString("base64")}`;
		expect(requests[0].headers?.authorization).toBe(expected);
		expect(requests[0].body).toContain("grant_type=client_credentials");
		expect(requests[0].body).not.toContain("client_id=");
	});

	it("clientAuth=body puts credentials in the form body, no basic header", async () => {
		const requests: Array<{
			url: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		}> = [];
		const provider = createOAuth2CcProvider(
			{ ...PROFILE, clientAuth: "body" },
			{
				fetchImpl: fakeFetch({
					body: { access_token: "tok-B", expires_in: 600 },
					captureRequests: requests,
				}),
			},
		);
		await provider.resolve({ toolName: "t" });
		expect(requests[0].headers?.authorization).toBeUndefined();
		expect(requests[0].body).toContain("client_id=cid-1");
		expect(requests[0].body).toContain("client_secret=csec-2");
	});

	it("scope + audience are forwarded as form fields when set", async () => {
		const requests: Array<{
			url: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		}> = [];
		const provider = createOAuth2CcProvider(
			{
				...PROFILE,
				scope: "orders:read orders:write",
				audience: "api.example.com",
			},
			{
				fetchImpl: fakeFetch({
					body: { access_token: "x", expires_in: 100 },
					captureRequests: requests,
				}),
			},
		);
		await provider.resolve({ toolName: "t" });
		expect(requests[0].body).toContain("scope=orders%3Aread+orders%3Awrite");
		expect(requests[0].body).toContain("audience=api.example.com");
	});

	it("cache hit — second resolve() within TTL does NOT call token endpoint again", async () => {
		const requests: Array<{
			url: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		}> = [];
		let nowMs = 1_000_000;
		const provider = createOAuth2CcProvider(PROFILE, {
			now: () => nowMs,
			fetchImpl: fakeFetch({
				body: { access_token: "tok-C", expires_in: 3600 },
				captureRequests: requests,
			}),
		});
		await provider.resolve({ toolName: "t" });
		nowMs += 1000;
		await provider.resolve({ toolName: "t" });
		expect(requests).toHaveLength(1);
	});

	it("cache miss — second resolve() past refreshAt triggers a fresh token endpoint call", async () => {
		const requests: Array<{
			url: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		}> = [];
		let nowMs = 1_000_000;
		// expires_in 100 -> refresh at 100-60 = 40s
		const provider = createOAuth2CcProvider(PROFILE, {
			now: () => nowMs,
			fetchImpl: fakeFetch({
				body: { access_token: "tok-D", expires_in: 100 },
				captureRequests: requests,
			}),
		});
		await provider.resolve({ toolName: "t" });
		nowMs += 50_000;
		await provider.resolve({ toolName: "t" });
		expect(requests).toHaveLength(2);
	});

	it("concurrent calls during a refresh share the in-flight promise", async () => {
		const requests: Array<{
			url: string;
			method?: string;
			headers?: Record<string, string>;
			body?: string;
		}> = [];
		const provider = createOAuth2CcProvider(PROFILE, {
			fetchImpl: fakeFetch({
				body: { access_token: "tok-E", expires_in: 600 },
				captureRequests: requests,
				delayMs: 30,
			}),
		});
		const [a, b, c] = await Promise.all([
			provider.resolve({ toolName: "t" }),
			provider.resolve({ toolName: "t" }),
			provider.resolve({ toolName: "t" }),
		]);
		expect(requests).toHaveLength(1);
		expect(a.headers.Authorization).toBe("Bearer tok-E");
		expect(b.headers.Authorization).toBe("Bearer tok-E");
		expect(c.headers.Authorization).toBe("Bearer tok-E");
	});
});

describe("oauth2-cc provider — error paths", () => {
	it("401 from token endpoint -> AuthResolveError; cache stays clear", async () => {
		const provider = createOAuth2CcProvider(PROFILE, {
			fetchImpl: fakeFetch({
				status: 401,
				bodyText: '{"error":"invalid_client"}',
			}),
			profileName: "p",
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			AuthResolveError,
		);
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(/401/);
	});

	it("non-JSON body -> AuthResolveError", async () => {
		const provider = createOAuth2CcProvider(PROFILE, {
			fetchImpl: fakeFetch({ bodyText: "<html>not json</html>" }),
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			/non-JSON/,
		);
	});

	it("response missing access_token -> AuthResolveError", async () => {
		const provider = createOAuth2CcProvider(PROFILE, {
			fetchImpl: fakeFetch({ body: { expires_in: 60 } }),
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			/access_token/,
		);
	});

	it("after a failed refresh, the next resolve() retries (cache not poisoned)", async () => {
		let call = 0;
		const fetchImpl = vi.fn(async () => {
			call++;
			if (call === 1) {
				return {
					ok: false,
					status: 500,
					async text() {
						return "boom";
					},
				} as unknown as Response;
			}
			return {
				ok: true,
				status: 200,
				async text() {
					return JSON.stringify({ access_token: "tok-rec", expires_in: 600 });
				},
			} as unknown as Response;
		}) as unknown as typeof import("undici").fetch;
		const provider = createOAuth2CcProvider(PROFILE, { fetchImpl });
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow();
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers.Authorization).toBe("Bearer tok-rec");
	});
});
