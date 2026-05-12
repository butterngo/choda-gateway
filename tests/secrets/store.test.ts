import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecryptError, SecretMissingError } from "../../src/secrets/errors.js";
import {
	initSecretStore,
	openSecretStore,
	setSecret,
} from "../../src/secrets/store.js";

const PASSWORD = "spike-test-pw-1";

let dir: string;
let storePath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "secret-store-"));
	storePath = join(dir, "secrets.enc");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function fileSha256(path: string): Promise<string> {
	const buf = await readFile(path);
	return createHash("sha256").update(buf).digest("hex");
}

describe("secret store — happy path", () => {
	it("init + set + reopen + get returns the original value", async () => {
		await initSecretStore({ storePath });
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "LINEAR_API_KEY",
			value: "secret123",
		});

		const store = await openSecretStore({
			storePath,
			password: PASSWORD,
			required: ["LINEAR_API_KEY"],
		});
		await expect(store.get("LINEAR_API_KEY")).resolves.toBe("secret123");
	});

	it("list returns names but never values; has() works", async () => {
		await initSecretStore({ storePath });
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "A",
			value: "alpha",
		});
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "B",
			value: "bravo",
		});

		const store = await openSecretStore({
			storePath,
			password: PASSWORD,
			required: ["A", "B"],
		});
		expect(await store.list()).toEqual(["A", "B"]);
		expect(await store.has("A")).toBe(true);
		expect(await store.has("Z")).toBe(false);
	});

	it("MAGIC bytes are 'CGSS01' and plaintext does not appear in file", async () => {
		await initSecretStore({ storePath });
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "K",
			value: "secret123",
		});
		const raw = await readFile(storePath);
		expect(raw.subarray(0, 6).toString("ascii")).toBe("CGSS01");
		expect(raw.includes(Buffer.from("secret123"))).toBe(false);
	});
});

describe("secret store — error paths", () => {
	it("wrong password throws DecryptError on get; file SHA256 unchanged", async () => {
		await initSecretStore({ storePath });
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "K",
			value: "secret123",
		});
		const shaBefore = await fileSha256(storePath);

		await expect(
			openSecretStore({ storePath, password: "wrong-pw", required: ["K"] }),
		).rejects.toBeInstanceOf(DecryptError);

		const shaAfter = await fileSha256(storePath);
		expect(shaAfter).toBe(shaBefore);
	});

	it("required missing throws SecretMissingError eagerly at open()", async () => {
		await initSecretStore({ storePath });
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "PRESENT",
			value: "ok",
		});

		await expect(
			openSecretStore({
				storePath,
				password: PASSWORD,
				required: ["MISSING_1", "MISSING_2"],
			}),
		).rejects.toMatchObject({
			name: "SecretMissingError",
			names: ["MISSING_1", "MISSING_2"],
		});
	});

	it("init refuses to overwrite an existing store", async () => {
		await initSecretStore({ storePath });
		await expect(initSecretStore({ storePath })).rejects.toThrow(
			/already exists/,
		);
	});
});

describe("secret store — maskValue", () => {
	it("returns true only for values exactly matching a loaded required secret", async () => {
		await initSecretStore({ storePath });
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "K",
			value: "abc123",
		});

		const store = await openSecretStore({
			storePath,
			password: PASSWORD,
			required: ["K"],
		});
		expect(store.maskValue("abc123")).toBe(true);
		expect(store.maskValue("xyz")).toBe(false);
		expect(store.maskValue("")).toBe(false); // empty values are skipped to avoid pathological matching
	});

	it("lazy get() adds the value to the mask set after first decrypt", async () => {
		await initSecretStore({ storePath });
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "REQ",
			value: "req-val",
		});
		await setSecret({
			storePath,
			password: PASSWORD,
			name: "LAZY",
			value: "lazy-val",
		});

		const store = await openSecretStore({
			storePath,
			password: PASSWORD,
			required: ["REQ"],
		});

		expect(store.maskValue("lazy-val")).toBe(false);
		await store.get("LAZY");
		expect(store.maskValue("lazy-val")).toBe(true);
	});
});
