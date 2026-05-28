import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADER_FIXED_END } from "../../src/secrets/header.js";
import {
	initSecretStore,
	openSecretStore,
	setSecret,
} from "../../src/secrets/store.js";

/**
 * Extract entry lines from a libsodium secret store buffer, ignoring the
 * fixed-length binary header. We cannot just `text.split("\n").slice(1)`
 * because the header's salt (16 random bytes) and KDF params can contain
 * 0x0A bytes — this caused TASK-976 flakes when run on real-random salts.
 * The header is exactly HEADER_FIXED_END bytes plus a trailing 0x0A.
 */
async function readEntryLines(storePath: string): Promise<string[]> {
	const buf = await readFile(storePath);
	let pos = HEADER_FIXED_END;
	if (buf[pos] === 0x0a) pos++;
	const tail = buf.subarray(pos).toString("utf8");
	return tail.split("\n").filter((l) => l.trim().length > 0);
}

const PASSWORD = "concurrent-pw";

let dir: string;
let storePath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "concurrent-"));
	storePath = join(dir, "secrets.enc");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("secret store — concurrency", () => {
	it("parallel setSecret on different names yields one valid line per call, no corruption", async () => {
		await initSecretStore({ storePath });
		const names = ["A", "B", "C", "D", "E", "F", "G", "H"];

		await Promise.all(
			names.map((n) =>
				setSecret({
					storePath,
					password: PASSWORD,
					name: n,
					value: `val-${n}`,
				}),
			),
		);

		const store = await openSecretStore({
			storePath,
			password: PASSWORD,
			required: names,
		});

		for (const n of names) {
			await expect(store.get(n)).resolves.toBe(`val-${n}`);
		}

		// Every entry line should parse as JSON with the three expected fields.
		const entryLines = await readEntryLines(storePath);
		expect(entryLines).toHaveLength(names.length);
		for (const line of entryLines) {
			const parsed = JSON.parse(line);
			expect(parsed).toHaveProperty("name");
			expect(parsed).toHaveProperty("nonce");
			expect(parsed).toHaveProperty("ct");
		}
	});

	// Regression for TASK-976 — appendFile races on Windows NTFS would
	// intermittently produce off-by-one entry counts under parallel writes.
	// Loop a moderate-concurrency batch 4× and demand exact line counts each
	// round; without the per-store write lock this fails deterministically on
	// Windows. Timeout is generous because the write lock now serialises
	// Argon2id-backed setSecret calls (~50ms each on CI hosts).
	it(
		"repeated high-concurrency parallel setSecret never produces stray lines (TASK-976 regression)",
		{ timeout: 30_000 },
		async () => {
			await initSecretStore({ storePath });
			const ROUNDS = 4;
			const PER_ROUND = 12;
			let written = 0;
			for (let round = 0; round < ROUNDS; round++) {
				const names = Array.from(
					{ length: PER_ROUND },
					(_, i) => `R${round}_K${i}`,
				);
				await Promise.all(
					names.map((n) =>
						setSecret({
							storePath,
							password: PASSWORD,
							name: n,
							value: `val-${n}`,
						}),
					),
				);
				written += PER_ROUND;

				const entryLines = await readEntryLines(storePath);
				expect(entryLines).toHaveLength(written);
				// Every line is well-formed JSON with the entry shape.
				for (const line of entryLines) {
					const parsed = JSON.parse(line);
					expect(parsed).toHaveProperty("name");
					expect(parsed).toHaveProperty("nonce");
					expect(parsed).toHaveProperty("ct");
				}
			}

			// And every secret round-trips through the cipher.
			const all = Array.from({ length: ROUNDS * PER_ROUND }, (_, idx) => {
				const round = Math.floor(idx / PER_ROUND);
				const k = idx % PER_ROUND;
				return `R${round}_K${k}`;
			});
			const store = await openSecretStore({
				storePath,
				password: PASSWORD,
				required: all,
			});
			for (const n of all) {
				await expect(store.get(n)).resolves.toBe(`val-${n}`);
			}
		},
	);

	it("setSecret + later overwriting setSecret of the same name resolves to the latest value", async () => {
		await initSecretStore({ storePath });
		await setSecret({ storePath, password: PASSWORD, name: "K", value: "old" });
		await setSecret({ storePath, password: PASSWORD, name: "K", value: "new" });

		const store = await openSecretStore({
			storePath,
			password: PASSWORD,
			required: ["K"],
		});
		await expect(store.get("K")).resolves.toBe("new");
	});
});
