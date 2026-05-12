import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecryptError, SecretMissingError } from "../../src/secrets/errors.js";
import {
	FALLBACK_MAGIC,
	initFallbackStore,
	loadFallbackStore,
	setFallbackSecret,
} from "../../src/secrets/fallback.js";

const PASSWORD = "fallback-test-pw";

let dir: string;
let storePath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "fallback-"));
	storePath = join(dir, "secrets.enc");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function fileSha256(path: string): Promise<string> {
	const buf = await readFile(path);
	return createHash("sha256").update(buf).digest("hex");
}

describe("fallback store — happy path", () => {
	it("init + set + reload + decrypt roundtrip", async () => {
		await initFallbackStore({ storePath });
		await setFallbackSecret({
			storePath,
			password: PASSWORD,
			name: "K",
			value: "v1",
		});

		const state = await loadFallbackStore({
			storePath,
			password: PASSWORD,
			required: ["K"],
		});
		expect(state.maskedValues.has("v1")).toBe(true);
	});

	it("MAGIC bytes are CGSS02 and plaintext absent from file", async () => {
		await initFallbackStore({ storePath });
		await setFallbackSecret({
			storePath,
			password: PASSWORD,
			name: "K",
			value: "abc123",
		});

		const raw = await readFile(storePath);
		expect(raw.subarray(0, 6).equals(FALLBACK_MAGIC)).toBe(true);
		expect(raw.includes(Buffer.from("abc123"))).toBe(false);
	});
});

describe("fallback store — error paths", () => {
	it("wrong password throws DecryptError; file SHA256 unchanged", async () => {
		await initFallbackStore({ storePath });
		await setFallbackSecret({
			storePath,
			password: PASSWORD,
			name: "K",
			value: "v1",
		});
		const shaBefore = await fileSha256(storePath);

		await expect(
			loadFallbackStore({ storePath, password: "wrong", required: ["K"] }),
		).rejects.toBeInstanceOf(DecryptError);

		expect(await fileSha256(storePath)).toBe(shaBefore);
	});

	it("required missing throws SecretMissingError", async () => {
		await initFallbackStore({ storePath });
		await setFallbackSecret({
			storePath,
			password: PASSWORD,
			name: "PRESENT",
			value: "p",
		});

		await expect(
			loadFallbackStore({
				storePath,
				password: PASSWORD,
				required: ["MISSING_X", "MISSING_Y"],
			}),
		).rejects.toMatchObject({
			name: "SecretMissingError",
			names: ["MISSING_X", "MISSING_Y"],
		});
	});

	it("rejects a CGSS01 file (libsodium MAGIC) when loaded as fallback", async () => {
		// Write a CGSS01-magic'd file by hand and try to load it as fallback.
		const fakeLibsodiumFile = Buffer.concat([
			Buffer.from("CGSS01", "ascii"),
			Buffer.alloc(16), // kdf params
			Buffer.alloc(16), // salt
			Buffer.from("\n", "ascii"),
		]);
		await import("node:fs/promises").then((fs) =>
			fs.writeFile(storePath, fakeLibsodiumFile),
		);

		await expect(
			loadFallbackStore({ storePath, password: PASSWORD, required: [] }),
		).rejects.toThrow(/bad magic for fallback store/);
	});

	it("init refuses to overwrite an existing store", async () => {
		await initFallbackStore({ storePath });
		await expect(initFallbackStore({ storePath })).rejects.toThrow(
			/already exists/,
		);
	});
});
