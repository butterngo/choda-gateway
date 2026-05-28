import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createCookieJarProvider,
	parseCookieFile,
} from "../../../src/auth/providers/cookie-jar.js";
import { AuthResolveError } from "../../../src/auth/types.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "cookie-jar-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeFileAt(name: string, body: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, body, "utf8");
	return path;
}

describe("parseCookieFile", () => {
	it("parses Netscape format (tab-separated)", () => {
		const text = [
			"# Netscape HTTP Cookie File",
			"# This is a comment",
			".example.com\tTRUE\t/\tFALSE\t1700000000\tsession\tabc123",
			"#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1700000000\ttoken\txyz789",
			"",
		].join("\n");
		expect(parseCookieFile(text)).toBe("session=abc123; token=xyz789");
	});

	it("parses inline name=value; name2=value2 format", () => {
		expect(parseCookieFile("session=abc; theme=dark\n")).toBe(
			"session=abc; theme=dark",
		);
	});

	it("skips blank lines and # comments", () => {
		const text = [
			"# header comment",
			"",
			"sid=1",
			"",
			"# another",
			"theme=dark",
			"",
		].join("\n");
		expect(parseCookieFile(text)).toBe("sid=1; theme=dark");
	});

	it("returns empty string for an empty file", () => {
		expect(parseCookieFile("")).toBe("");
	});

	it("returns empty string for a file with only comments", () => {
		expect(parseCookieFile("# just a header\n# blank file otherwise\n")).toBe(
			"",
		);
	});

	it("malformed lines are skipped (no '=' or empty key)", () => {
		expect(parseCookieFile("good=1; =badvalue; alsogood=2")).toBe(
			"good=1; alsogood=2",
		);
	});
});

describe("cookie-jar provider", () => {
	it("emits Cookie header from inline file", async () => {
		const path = await writeFileAt("cookies.txt", "session=abc; theme=dark\n");
		const provider = createCookieJarProvider({
			type: "cookie-jar",
			cookieFile: path,
			forwardHeaders: ["cookie"],
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers.cookie).toBe("session=abc; theme=dark");
	});

	it("emits cookie under each header named in forwardHeaders", async () => {
		const path = await writeFileAt("c.txt", "k=v\n");
		const provider = createCookieJarProvider({
			type: "cookie-jar",
			cookieFile: path,
			forwardHeaders: ["Cookie", "X-Forwarded-Cookie"],
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers.Cookie).toBe("k=v");
		expect(auth.headers["X-Forwarded-Cookie"]).toBe("k=v");
	});

	it("extraHeaders are merged in (tenant tag pattern)", async () => {
		const path = await writeFileAt("c.txt", "sid=1\n");
		const provider = createCookieJarProvider({
			type: "cookie-jar",
			cookieFile: path,
			forwardHeaders: ["cookie"],
			extraHeaders: { "X-Tenant-Id": "tenant-a" },
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers.cookie).toBe("sid=1");
		expect(auth.headers["X-Tenant-Id"]).toBe("tenant-a");
	});

	it("empty cookie file still emits extraHeaders, no Cookie header", async () => {
		const path = await writeFileAt("empty.txt", "");
		const provider = createCookieJarProvider({
			type: "cookie-jar",
			cookieFile: path,
			forwardHeaders: ["cookie"],
			extraHeaders: { "X-Tenant-Id": "t" },
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers.cookie).toBeUndefined();
		expect(auth.headers["X-Tenant-Id"]).toBe("t");
	});

	it("missing file -> typed error naming the file", async () => {
		const provider = createCookieJarProvider({
			type: "cookie-jar",
			cookieFile: join(dir, "no-such.txt"),
			forwardHeaders: ["cookie"],
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			AuthResolveError,
		);
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			/cookie-jar file not found/,
		);
	});

	it("mtime-based reload: changing the file picks up new content on the next resolve()", async () => {
		const path = await writeFileAt("c.txt", "sid=v1\n");
		const provider = createCookieJarProvider({
			type: "cookie-jar",
			cookieFile: path,
			forwardHeaders: ["cookie"],
		});
		const first = await provider.resolve({ toolName: "t" });
		expect(first.headers.cookie).toBe("sid=v1");

		await writeFile(path, "sid=v2\n", "utf8");
		// Force a future mtime to defeat sub-millisecond identical timestamps
		// some filesystems produce when writes land in the same tick.
		const future = new Date(Date.now() + 5_000);
		await utimes(path, future, future);

		const second = await provider.resolve({ toolName: "t" });
		expect(second.headers.cookie).toBe("sid=v2");
	});

	it("type discriminator is set", () => {
		const provider = createCookieJarProvider({
			type: "cookie-jar",
			cookieFile: join(dir, "x"),
			forwardHeaders: ["cookie"],
		});
		expect(provider.type).toBe("cookie-jar");
	});
});
