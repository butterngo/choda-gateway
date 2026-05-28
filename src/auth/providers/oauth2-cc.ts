import { fetch } from "undici";
import {
	type AuthProfile,
	AuthResolveError,
	type CallContext,
	type CredentialProvider,
	type ResolvedAuth,
} from "../types.js";

type OAuth2CcProfile = Extract<AuthProfile, { type: "oauth2-cc" }>;

interface CachedToken {
	accessToken: string;
	refreshAt: number;
}

export interface OAuth2CcProviderOptions {
	fetchImpl?: typeof fetch;
	now?: () => number;
	profileName?: string;
	/**
	 * Safety margin before token expiry to trigger refresh, in milliseconds.
	 * Default 60s matches ADR-006 spec.
	 */
	refreshSafetyMs?: number;
}

const DEFAULT_REFRESH_SAFETY_MS = 60_000;

interface TokenEndpointResponse {
	access_token?: unknown;
	expires_in?: unknown;
	token_type?: unknown;
}

export function createOAuth2CcProvider(
	profile: OAuth2CcProfile,
	opts: OAuth2CcProviderOptions = {},
): CredentialProvider {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	const safetyMs = opts.refreshSafetyMs ?? DEFAULT_REFRESH_SAFETY_MS;
	const profileName = opts.profileName ?? "oauth2-cc";

	let cached: CachedToken | null = null;
	let inFlight: Promise<CachedToken> | null = null;

	async function refresh(): Promise<CachedToken> {
		const body = new URLSearchParams({ grant_type: "client_credentials" });
		if (profile.scope) body.set("scope", profile.scope);
		if (profile.audience) body.set("audience", profile.audience);

		const headers: Record<string, string> = {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		};

		if (profile.clientAuth === "basic") {
			const creds = `${profile.clientId}:${profile.clientSecret}`;
			headers.authorization = `Basic ${Buffer.from(creds, "utf8").toString("base64")}`;
		} else {
			body.set("client_id", profile.clientId);
			body.set("client_secret", profile.clientSecret);
		}

		const res = await fetchImpl(profile.tokenUrl, {
			method: "POST",
			headers,
			body: body.toString(),
		});

		const text = await res.text();
		if (!res.ok) {
			throw new AuthResolveError(
				`oauth2-cc token endpoint returned ${res.status}: ${truncate(text, 200)}`,
				profileName,
			);
		}

		let parsed: TokenEndpointResponse;
		try {
			parsed = JSON.parse(text) as TokenEndpointResponse;
		} catch (cause) {
			throw new AuthResolveError(
				"oauth2-cc token endpoint returned non-JSON body",
				profileName,
				cause,
			);
		}

		if (
			typeof parsed.access_token !== "string" ||
			parsed.access_token.length === 0
		) {
			throw new AuthResolveError(
				"oauth2-cc token endpoint response missing access_token",
				profileName,
			);
		}
		const expiresInSec =
			typeof parsed.expires_in === "number" && parsed.expires_in > 0
				? parsed.expires_in
				: 3600;
		const refreshAt = now() + expiresInSec * 1000 - safetyMs;

		return {
			accessToken: parsed.access_token,
			refreshAt,
		};
	}

	return {
		type: "oauth2-cc",
		async resolve(_ctx: CallContext): Promise<ResolvedAuth> {
			if (cached && now() < cached.refreshAt) {
				return { headers: { Authorization: `Bearer ${cached.accessToken}` } };
			}
			if (!inFlight) {
				inFlight = (async () => {
					try {
						const next = await refresh();
						cached = next;
						return next;
					} catch (err) {
						cached = null;
						throw err;
					} finally {
						inFlight = null;
					}
				})();
			}
			const next = await inFlight;
			return { headers: { Authorization: `Bearer ${next.accessToken}` } };
		},
	};
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}
