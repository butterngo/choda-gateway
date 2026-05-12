import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initSecretStore,
	openSecretStore,
	setSecret,
} from "../../src/secrets/store.js";

const PASSWORD = "dispatch-pw";

let dir: string;
let storePath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "store-dispatch-"));
	storePath = join(dir, "secrets.enc");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("openSecretStore — dispatch by file MAGIC", () => {
	it("routes a CGSS01 (libsodium) file through the libsodium path; cryptoBackend = 'libsodium'", async () => {
		await initSecretStore({ storePath, backend: "libsodium" });
		await setSecret({ storePath, password: PASSWORD, name: "K", value: "v" });

		const store = await openSecretStore({
			storePath,
			password: PASSWORD,
			required: ["K"],
		});
		expect(store.cryptoBackend).toBe("libsodium");
		await expect(store.get("K")).resolves.toBe("v");
	});

	it("routes a CGSS02 (node:crypto fallback) file through the fallback path; cryptoBackend = 'node:crypto'", async () => {
		await initSecretStore({ storePath, backend: "node:crypto" });
		await setSecret({ storePath, password: PASSWORD, name: "K", value: "v" });

		const store = await openSecretStore({
			storePath,
			password: PASSWORD,
			required: ["K"],
		});
		expect(store.cryptoBackend).toBe("node:crypto");
		await expect(store.get("K")).resolves.toBe("v");
	});

	it("setSecret on a CGSS02 file uses the fallback path (decryptable with the same backend)", async () => {
		await initSecretStore({ storePath, backend: "node:crypto" });
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
		await expect(store.get("A")).resolves.toBe("alpha");
		await expect(store.get("B")).resolves.toBe("bravo");
	});

	it("rejects a file with neither MAGIC", async () => {
		const fs = await import("node:fs/promises");
		await fs.writeFile(storePath, Buffer.from("NOTAMAGIC\nsomething", "ascii"));
		await expect(
			openSecretStore({ storePath, password: PASSWORD, required: [] }),
		).rejects.toThrow(/unrecognised secret-store MAGIC/);
	});
});
