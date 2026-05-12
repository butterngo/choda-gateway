import { readFile, writeFile } from "node:fs/promises";
import { parseEntries, readHeader } from "./header.js";

export interface RemoveSecretOptions {
	storePath: string;
	name: string;
}

/**
 * Drop every entry with the given name from the encrypted store.
 * Re-writes the file with the same KDF params + salt, preserving the remaining
 * (still encrypted) ciphertext lines unchanged. Returns `true` if at least one
 * entry was removed, `false` if no matching entry existed.
 *
 * Does NOT require the password — the file's confidentiality is unchanged;
 * any local actor with file access could already delete the file outright.
 */
export async function removeSecret(
	opts: RemoveSecretOptions,
): Promise<boolean> {
	const fileBuf = await readFile(opts.storePath);
	const header = readHeader(fileBuf);
	const entries = parseEntries(header.entriesText);
	const headerBytes = fileBuf.subarray(
		0,
		fileBuf.length - header.entriesText.length,
	);

	const kept = entries.filter((e) => e.name !== opts.name);
	if (kept.length === entries.length) return false;

	const lines = kept
		.map((e) => JSON.stringify({ name: e.name, nonce: e.nonce, ct: e.ct }))
		.join("\n");
	const trailing = lines.length === 0 ? "" : `${lines}\n`;
	const newBuf = Buffer.concat([
		Buffer.from(headerBytes),
		Buffer.from(trailing, "utf8"),
	]);
	await writeFile(opts.storePath, newBuf);
	return true;
}
