import { readFile, stat } from "node:fs/promises";
import {
	type AuthProfile,
	AuthResolveError,
	type CallContext,
	type CredentialProvider,
	type ResolvedAuth,
} from "../types.js";

type CookieJarProfile = Extract<AuthProfile, { type: "cookie-jar" }>;

interface CacheEntry {
	mtimeMs: number;
	cookieString: string;
}

export interface CookieJarProviderOptions {
	profileName?: string;
	/** Override fs.stat for tests. */
	statImpl?: typeof stat;
	/** Override fs.readFile for tests. */
	readFileImpl?: typeof readFile;
}

export function createCookieJarProvider(
	profile: CookieJarProfile,
	opts: CookieJarProviderOptions = {},
): CredentialProvider {
	const statImpl = opts.statImpl ?? stat;
	const readFileImpl = opts.readFileImpl ?? readFile;
	const profileName = opts.profileName ?? "cookie-jar";
	let cache: CacheEntry | null = null;

	async function readCookies(): Promise<string> {
		let mtimeMs: number;
		try {
			const st = await statImpl(profile.cookieFile);
			mtimeMs = st.mtimeMs;
		} catch (cause) {
			throw new AuthResolveError(
				`cookie-jar file not found: ${profile.cookieFile}`,
				profileName,
				cause,
			);
		}
		if (cache && cache.mtimeMs === mtimeMs) {
			return cache.cookieString;
		}
		let text: string;
		try {
			text = await readFileImpl(profile.cookieFile, "utf8");
		} catch (cause) {
			throw new AuthResolveError(
				`cookie-jar file read failed: ${profile.cookieFile}`,
				profileName,
				cause,
			);
		}
		const cookieString = parseCookieFile(text);
		cache = { mtimeMs, cookieString };
		return cookieString;
	}

	return {
		type: "cookie-jar",
		async resolve(_ctx: CallContext): Promise<ResolvedAuth> {
			const cookieString = await readCookies();
			const headers: Record<string, string> = {};
			if (cookieString.length > 0) {
				for (const name of profile.forwardHeaders) {
					headers[name] = cookieString;
				}
			}
			if (profile.extraHeaders) {
				for (const [k, v] of Object.entries(profile.extraHeaders)) {
					headers[k] = v;
				}
			}
			return { headers };
		},
	};
}

/**
 * Parse a cookie file into a single `Cookie:` header value.
 *
 * Supports two formats, auto-detected:
 * 1. Netscape (`curl --cookie-jar` output): tab-separated 7 columns
 *    (`domain  flag  path  secure  expires  name  value`).
 * 2. Inline: one or more lines of `name=value; name2=value2`.
 *
 * Lines starting with `#` (or `# HttpOnly_` for marker comments) and blank
 * lines are skipped. Returns an empty string when no cookies are present.
 */
export function parseCookieFile(text: string): string {
	const cookies: string[] = [];
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = stripHttpOnlyMarker(rawLine).trim();
		if (line.length === 0) continue;
		if (line.startsWith("#")) continue;
		if (line.includes("\t")) {
			const parts = line.split("\t");
			if (parts.length >= 7) {
				const name = parts[5];
				const value = parts[6];
				if (name.length > 0) cookies.push(`${name}=${value}`);
			}
			continue;
		}
		for (const pair of line.split(";")) {
			const trimmed = pair.trim();
			if (trimmed.length === 0) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			cookies.push(trimmed);
		}
	}
	return cookies.join("; ");
}

function stripHttpOnlyMarker(line: string): string {
	if (line.startsWith("#HttpOnly_")) return line.slice("#HttpOnly_".length);
	return line;
}
