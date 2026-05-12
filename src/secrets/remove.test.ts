import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeSecret } from "./remove.js";
import { initSecretStore, openSecretStore, setSecret } from "./store.js";

let dir: string;
let storePath: string;
const password = "test-pw-12345";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "cgss-rm-"));
	storePath = join(dir, "secrets.enc");
	await initSecretStore({ storePath });
});

afterEach(async () => {
	if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
});

describe("removeSecret", () => {
	it("returns false when entry does not exist", async () => {
		const removed = await removeSecret({ storePath, name: "GHOST" });
		expect(removed).toBe(false);
	});

	it("removes a single entry — subsequent get() throws SecretMissingError", async () => {
		await setSecret({ storePath, password, name: "KEY_A", value: "value-a" });
		await setSecret({ storePath, password, name: "KEY_B", value: "value-b" });

		// Sanity: both reachable.
		const before = await openSecretStore({
			storePath,
			password,
			required: ["KEY_A", "KEY_B"],
		});
		expect(await before.get("KEY_A")).toBe("value-a");
		expect(await before.get("KEY_B")).toBe("value-b");

		const removed = await removeSecret({ storePath, name: "KEY_A" });
		expect(removed).toBe(true);

		const after = await openSecretStore({
			storePath,
			password,
			required: ["KEY_B"],
		});
		expect(await after.has("KEY_A")).toBe(false);
		expect(await after.get("KEY_B")).toBe("value-b");
	});

	it("does NOT need the password to remove an entry (encrypted bytes preserved)", async () => {
		await setSecret({ storePath, password, name: "KEY_A", value: "value-a" });
		const removed = await removeSecret({ storePath, name: "KEY_A" });
		expect(removed).toBe(true);
	});

	it("preserves the file header bytes (MAGIC CGSS01 + KDF params + salt)", async () => {
		await setSecret({ storePath, password, name: "KEY_A", value: "value-a" });
		const before = await readFile(storePath);
		const headerBefore = before.subarray(0, 39); // MAGIC(6) + KDF(16) + SALT(16) + '\n'
		await removeSecret({ storePath, name: "KEY_A" });
		const after = await readFile(storePath);
		const headerAfter = after.subarray(0, 39);
		expect(headerAfter.equals(headerBefore)).toBe(true);
		expect(after.subarray(0, 6).toString("ascii")).toBe("CGSS01");
	});

	it("removes ALL historical entries of the same name (last-wins semantics held)", async () => {
		await setSecret({ storePath, password, name: "KEY_X", value: "v1" });
		await setSecret({ storePath, password, name: "KEY_X", value: "v2" });
		await setSecret({ storePath, password, name: "KEY_X", value: "v3" });
		const removed = await removeSecret({ storePath, name: "KEY_X" });
		expect(removed).toBe(true);
		const after = await openSecretStore({
			storePath,
			password,
			required: [],
		});
		expect(await after.has("KEY_X")).toBe(false);
	});
});
