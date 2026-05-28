import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectProfileSecretRefs,
	loadProfiles,
} from "../../src/auth/profiles.js";
import { AuthProfileError } from "../../src/auth/types.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "auth-profiles-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeYaml(name: string, body: string): Promise<string> {
	const path = join(dir, name);
	await writeFile(path, body, "utf8");
	return path;
}

function fakeStore(values: Record<string, string>) {
	return {
		async has(name: string) {
			return Object.hasOwn(values, name);
		},
		async get(name: string) {
			if (!Object.hasOwn(values, name)) throw new Error(`missing: ${name}`);
			return values[name];
		},
	};
}

describe("loadProfiles — happy path", () => {
	it("loads all 5 provider types with secret + path substitution", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  ichiba-prod:",
				"    type: oauth2-cc",
				"    tokenUrl: https://auth.ichiba.example/oauth/token",
				"    clientId: ${secret:ICHIBA_CID}",
				"    clientSecret: ${secret:ICHIBA_CSEC}",
				"    scope: orders:read",
				"  mantu-dev:",
				"    type: cookie-jar",
				"    cookieFile: ${path:mantu_cookies}",
				"    forwardHeaders: [cookie]",
				"    extraHeaders:",
				"      X-Tenant-Id: tenant-a",
				"  petstore-key:",
				"    type: api-key",
				"    location: header",
				"    name: X-API-Key",
				"    value: ${secret:PETSTORE_KEY}",
				"  bearer-dev:",
				"    type: bearer-static",
				"    token: ${secret:DEV_TOKEN}",
				"  gcloud:",
				"    type: exec-script",
				"    command: [gcloud, auth, print-access-token]",
				"    cacheTtlSeconds: 3000",
				"    headerTemplate:",
				"      Authorization: Bearer {output}",
				"",
			].join("\n"),
		);
		const store = fakeStore({
			ICHIBA_CID: "cid-xxx",
			ICHIBA_CSEC: "csec-yyy",
			PETSTORE_KEY: "pk-zzz",
			DEV_TOKEN: "tok-www",
		});
		const result = await loadProfiles({
			yamlPath: path,
			secretStore: store,
			paths: { mantu_cookies: "/tmp/cookies.txt" },
		});

		expect(result.warnings).toEqual([]);
		expect(result.profiles.size).toBe(5);

		const oauth = result.profiles.get("ichiba-prod");
		if (oauth?.type !== "oauth2-cc")
			throw new Error("expected oauth2-cc profile");
		expect(oauth.clientId).toBe("cid-xxx");
		expect(oauth.clientSecret).toBe("csec-yyy");

		const cookie = result.profiles.get("mantu-dev");
		if (cookie?.type !== "cookie-jar")
			throw new Error("expected cookie-jar profile");
		expect(cookie.cookieFile).toBe("/tmp/cookies.txt");
		expect(cookie.forwardHeaders).toEqual(["cookie"]);

		const key = result.profiles.get("petstore-key");
		if (key?.type !== "api-key") throw new Error("expected api-key profile");
		expect(key.value).toBe("pk-zzz");
	});

	it("defaults applied: oauth2-cc.clientAuth=basic, exec-script.parseOutputAs=raw, exec-script.timeoutMs=30000, cookie-jar.forwardHeaders=[cookie]", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  o:",
				"    type: oauth2-cc",
				"    tokenUrl: https://x/token",
				"    clientId: ${secret:CID}",
				"    clientSecret: ${secret:CSEC}",
				"  c:",
				"    type: cookie-jar",
				"    cookieFile: ${path:p}",
				"  e:",
				"    type: exec-script",
				"    command: [echo, hi]",
				"    cacheTtlSeconds: 60",
				"",
			].join("\n"),
		);
		const { profiles } = await loadProfiles({
			yamlPath: path,
			secretStore: fakeStore({ CID: "a", CSEC: "b" }),
			paths: { p: "/cookies" },
		});
		const o = profiles.get("o");
		const c = profiles.get("c");
		const e = profiles.get("e");
		if (o?.type !== "oauth2-cc") throw new Error("o type");
		if (c?.type !== "cookie-jar") throw new Error("c type");
		if (e?.type !== "exec-script") throw new Error("e type");
		expect(o.clientAuth).toBe("basic");
		expect(c.forwardHeaders).toEqual(["cookie"]);
		expect(e.parseOutputAs).toBe("raw");
		expect(e.timeoutMs).toBe(30_000);
	});
});

describe("loadProfiles — error paths", () => {
	it("missing file -> typed error", async () => {
		await expect(
			loadProfiles({ yamlPath: join(dir, "no-such.yaml") }),
		).rejects.toThrow(AuthProfileError);
		await expect(
			loadProfiles({ yamlPath: join(dir, "no-such.yaml") }),
		).rejects.toThrow(/cannot read auth profiles file/);
	});

	it("malformed YAML -> typed error", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			"::: not yaml :::\n  - [",
		);
		await expect(loadProfiles({ yamlPath: path })).rejects.toThrow(
			/malformed YAML/,
		);
	});

	it("unknown provider type -> validation error", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  bad:",
				"    type: jwt-magic",
				"    secret: ${secret:X}",
				"",
			].join("\n"),
		);
		await expect(
			loadProfiles({ yamlPath: path, secretStore: fakeStore({ X: "v" }) }),
		).rejects.toThrow(/validation failed/);
	});

	it("missing secret key -> error naming the key + path", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  bs:",
				"    type: bearer-static",
				"    token: ${secret:UNKNOWN_KEY}",
				"",
			].join("\n"),
		);
		await expect(
			loadProfiles({ yamlPath: path, secretStore: fakeStore({}) }),
		).rejects.toThrow(/unknown secret 'UNKNOWN_KEY'/);
		await expect(
			loadProfiles({ yamlPath: path, secretStore: fakeStore({}) }),
		).rejects.toThrow(/profiles\.bs\.token/);
	});

	it("missing path key -> error naming the key + path", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  cj:",
				"    type: cookie-jar",
				"    cookieFile: ${path:nope}",
				"",
			].join("\n"),
		);
		await expect(loadProfiles({ yamlPath: path, paths: {} })).rejects.toThrow(
			/unknown path key 'nope'/,
		);
	});

	it("unknown placeholder kind -> error", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  bs:",
				"    type: bearer-static",
				"    token: ${env:FOO}",
				"",
			].join("\n"),
		);
		await expect(loadProfiles({ yamlPath: path })).rejects.toThrow(
			/unknown placeholder kind 'env'/,
		);
	});

	it("secret reference without secretStore -> typed error", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  bs:",
				"    type: bearer-static",
				"    token: ${secret:X}",
				"",
			].join("\n"),
		);
		await expect(loadProfiles({ yamlPath: path })).rejects.toThrow(
			/no secret store available/,
		);
	});

	it("empty profiles map -> error", async () => {
		const path = await writeYaml("auth-profiles.yaml", "profiles: {}\n");
		await expect(loadProfiles({ yamlPath: path })).rejects.toThrow(
			/at least one profile must be defined/,
		);
	});

	it("invalid profile name -> error", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  Bad_Name:",
				"    type: bearer-static",
				"    token: ${secret:X}",
				"",
			].join("\n"),
		);
		await expect(
			loadProfiles({ yamlPath: path, secretStore: fakeStore({ X: "v" }) }),
		).rejects.toThrow(/Bad_Name/);
	});

	it("oauth2-cc rejects non-https tokenUrl (except localhost)", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  o:",
				"    type: oauth2-cc",
				"    tokenUrl: http://auth.example.com/token",
				"    clientId: ${secret:CID}",
				"    clientSecret: ${secret:CSEC}",
				"",
			].join("\n"),
		);
		await expect(
			loadProfiles({
				yamlPath: path,
				secretStore: fakeStore({ CID: "a", CSEC: "b" }),
			}),
		).rejects.toThrow(/tokenUrl must be https/);
	});

	it("oauth2-cc allows http://localhost for testing", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  o:",
				"    type: oauth2-cc",
				"    tokenUrl: http://localhost:8080/token",
				"    clientId: ${secret:CID}",
				"    clientSecret: ${secret:CSEC}",
				"",
			].join("\n"),
		);
		const { profiles } = await loadProfiles({
			yamlPath: path,
			secretStore: fakeStore({ CID: "a", CSEC: "b" }),
		});
		expect(profiles.has("o")).toBe(true);
	});
});

describe("loadProfiles — plaintext-secret warnings", () => {
	it("warns when bearer-static.token is plaintext", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  bs:",
				"    type: bearer-static",
				"    token: hardcoded-dev-token",
				"",
			].join("\n"),
		);
		const { warnings } = await loadProfiles({ yamlPath: path });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatch(/profile 'bs'/);
		expect(warnings[0]).toMatch(/token/);
		expect(warnings[0]).toMatch(/plaintext/);
	});

	it("warns when oauth2-cc.clientSecret is plaintext", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  o:",
				"    type: oauth2-cc",
				"    tokenUrl: https://x/token",
				"    clientId: id-1",
				"    clientSecret: literal-secret-bad",
				"",
			].join("\n"),
		);
		const { warnings } = await loadProfiles({ yamlPath: path });
		expect(warnings.some((w) => /clientSecret/.test(w))).toBe(true);
	});

	it("does NOT warn when sensitive field uses ${secret:...}", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  bs:",
				"    type: bearer-static",
				"    token: ${secret:DEV_TOKEN}",
				"",
			].join("\n"),
		);
		const { warnings } = await loadProfiles({
			yamlPath: path,
			secretStore: fakeStore({ DEV_TOKEN: "abc" }),
		});
		expect(warnings).toEqual([]);
	});
});

describe("collectProfileSecretRefs", () => {
	it("returns sorted distinct secret names referenced in the file", async () => {
		const path = await writeYaml(
			"auth-profiles.yaml",
			[
				"profiles:",
				"  a:",
				"    type: bearer-static",
				"    token: ${secret:Z_KEY}",
				"  b:",
				"    type: api-key",
				"    location: header",
				"    name: X-K",
				"    value: ${secret:A_KEY}",
				"  c:",
				"    type: oauth2-cc",
				"    tokenUrl: https://x/t",
				"    clientId: ${secret:A_KEY}",
				"    clientSecret: ${secret:M_KEY}",
				"",
			].join("\n"),
		);
		expect(await collectProfileSecretRefs(path)).toEqual([
			"A_KEY",
			"M_KEY",
			"Z_KEY",
		]);
	});
});
