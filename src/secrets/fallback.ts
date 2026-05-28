import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { DecryptError, SecretMissingError } from "./errors.js";
import {
	HEADER_FIXED_END,
	KDF_PARAMS_BYTES,
	SALT_BYTES,
	parseEntries,
} from "./header.js";
import { withStoreWriteLock } from "./locks.js";

/**
 * Explicit-opt-in fallback secret store. Same on-disk shape as the libsodium
 * store (header + JSONL entries) but with:
 *   - MAGIC = "CGSS02" — a different bytes-0..6 string so libsodium-encrypted
 *     stores (CGSS01) cannot be silently mis-decrypted with the fallback.
 *   - KDF   = scrypt(N, r, p) — params encoded in the 16-byte header slot:
 *     `[N: u32 LE][r: u32 LE][p: u32 LE][reserved: 4B zero]`.
 *   - Cipher = AES-256-GCM. The 12-byte nonce is base64'd into the entry
 *     and the 16-byte auth tag is appended to the ciphertext so the entry
 *     JSON shape (`{ name, nonce, ct }`) is identical to the libsodium one.
 *
 * Activated only when libsodium init throws AND `GATEWAY_ALLOW_CRYPTO_FALLBACK=1`
 * — never silently. See `store.openSecretStore`.
 */

export const FALLBACK_MAGIC = Buffer.from("CGSS02", "ascii");
const NONCE_BYTES_FALLBACK = 12;
const TAG_BYTES = 16;
const KEY_BYTES_FALLBACK = 32;

// Conservative scrypt defaults. N=2^14 ~50ms on a workstation; aligns with the
// Argon2id INTERACTIVE budget the libsodium path uses.
const DEFAULT_N = 1 << 14;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

interface ScryptParams {
	N: number;
	r: number;
	p: number;
}

function packScryptParams(params: ScryptParams): Buffer {
	const buf = Buffer.alloc(KDF_PARAMS_BYTES);
	buf.writeUInt32LE(params.N, 0);
	buf.writeUInt32LE(params.r, 4);
	buf.writeUInt32LE(params.p, 8);
	// last 4 bytes reserved/zero
	return buf;
}

function unpackScryptParams(buf: Buffer): ScryptParams {
	return {
		N: buf.readUInt32LE(0),
		r: buf.readUInt32LE(4),
		p: buf.readUInt32LE(8),
	};
}

interface FallbackParsedHeader {
	scrypt: ScryptParams;
	salt: Buffer;
	entriesText: string;
}

function readFallbackHeader(fileBuf: Buffer): FallbackParsedHeader {
	if (fileBuf.length < HEADER_FIXED_END) {
		throw new Error(`fallback store too short (${fileBuf.length} bytes)`);
	}
	const magic = fileBuf.subarray(0, FALLBACK_MAGIC.length);
	if (!magic.equals(FALLBACK_MAGIC)) {
		throw new Error(
			`bad magic for fallback store: expected ${FALLBACK_MAGIC.toString()}, got ${magic.toString()}`,
		);
	}
	const scrypt = unpackScryptParams(
		fileBuf.subarray(
			FALLBACK_MAGIC.length,
			FALLBACK_MAGIC.length + KDF_PARAMS_BYTES,
		),
	);
	const salt = Buffer.from(
		fileBuf.subarray(
			FALLBACK_MAGIC.length + KDF_PARAMS_BYTES,
			HEADER_FIXED_END,
		),
	);
	let pos = HEADER_FIXED_END;
	if (fileBuf[pos] === 0x0a) pos++;
	const entriesText = fileBuf.subarray(pos).toString("utf8");
	return { scrypt, salt, entriesText };
}

function buildFallbackHeader(params: ScryptParams, salt: Buffer): Buffer {
	return Buffer.concat([
		FALLBACK_MAGIC,
		packScryptParams(params),
		salt,
		Buffer.from("\n", "ascii"),
	]);
}

function deriveKeyFallback(
	password: string,
	salt: Buffer,
	params: ScryptParams,
): Buffer {
	return scryptSync(password, salt, KEY_BYTES_FALLBACK, {
		N: params.N,
		r: params.r,
		p: params.p,
		// Node's default maxmem is too tight for N=2^14 — bump it.
		maxmem: 128 * params.N * params.r * 2,
	});
}

function encryptFallback(
	plaintext: string,
	key: Buffer,
): { nonce: Buffer; ct: Buffer } {
	const nonce = randomBytes(NONCE_BYTES_FALLBACK);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return { nonce, ct: Buffer.concat([enc, tag]) };
}

function decryptFallback(
	ctWithTagB64: string,
	nonceB64: string,
	key: Buffer,
	name: string,
): string {
	const nonce = Buffer.from(nonceB64, "base64");
	const ctWithTag = Buffer.from(ctWithTagB64, "base64");
	if (ctWithTag.length < TAG_BYTES) {
		throw new DecryptError(name, new Error("ciphertext shorter than auth tag"));
	}
	const ct = ctWithTag.subarray(0, ctWithTag.length - TAG_BYTES);
	const tag = ctWithTag.subarray(ctWithTag.length - TAG_BYTES);
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAuthTag(tag);
		const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
		return pt.toString("utf8");
	} catch (cause) {
		throw new DecryptError(name, cause);
	}
}

export interface FallbackInitOptions {
	storePath: string;
	scrypt?: Partial<ScryptParams>;
}

export async function initFallbackStore(
	opts: FallbackInitOptions,
): Promise<void> {
	if (existsSync(opts.storePath)) {
		throw new Error(`store already exists at ${opts.storePath}`);
	}
	const params: ScryptParams = {
		N: opts.scrypt?.N ?? DEFAULT_N,
		r: opts.scrypt?.r ?? DEFAULT_R,
		p: opts.scrypt?.p ?? DEFAULT_P,
	};
	const salt = randomBytes(SALT_BYTES);
	await writeFile(opts.storePath, buildFallbackHeader(params, salt));
}

export interface FallbackSetOptions {
	storePath: string;
	password: string;
	name: string;
	value: string;
}

export async function setFallbackSecret(
	opts: FallbackSetOptions,
): Promise<void> {
	const fileBuf = await readFile(opts.storePath);
	const { scrypt, salt } = readFallbackHeader(fileBuf);
	const key = deriveKeyFallback(opts.password, salt, scrypt);
	const { nonce, ct } = encryptFallback(opts.value, key);
	const line = `${JSON.stringify({
		name: opts.name,
		nonce: nonce.toString("base64"),
		ct: ct.toString("base64"),
	})}\n`;
	// Read-then-writeFile under the lock — same approach as setSecret;
	// avoids unreliable fs.appendFile on Windows NTFS (TASK-976).
	await withStoreWriteLock(opts.storePath, async () => {
		const existing = await readFile(opts.storePath);
		await writeFile(
			opts.storePath,
			Buffer.concat([existing, Buffer.from(line, "utf8")]),
		);
	});
}

export interface FallbackOpenOptions {
	storePath: string;
	password: string;
	required: string[];
}

export interface FallbackStoreState {
	latestByName: Map<string, { ct: string; nonce: string }>;
	key: Buffer;
	maskedValues: Set<string>;
}

/**
 * Decrypt the `required` set and return state usable by the public SecretStore
 * facade in `store.ts`. Throws SecretMissingError / DecryptError with the same
 * semantics as the libsodium path.
 */
export async function loadFallbackStore(
	opts: FallbackOpenOptions,
): Promise<FallbackStoreState> {
	const fileBuf = await readFile(opts.storePath);
	const { scrypt, salt, entriesText } = readFallbackHeader(fileBuf);
	const entries = parseEntries(entriesText);
	const latestByName = new Map<string, { ct: string; nonce: string }>();
	for (const e of entries) {
		latestByName.set(e.name, { ct: e.ct, nonce: e.nonce });
	}

	const key = deriveKeyFallback(opts.password, salt, scrypt);

	const missing: string[] = [];
	const maskedValues = new Set<string>();
	for (const name of opts.required) {
		const entry = latestByName.get(name);
		if (!entry) {
			missing.push(name);
			continue;
		}
		const value = decryptFallback(entry.ct, entry.nonce, key, name);
		maskedValues.add(value);
	}
	if (missing.length > 0) {
		throw new SecretMissingError(missing);
	}

	return { latestByName, key, maskedValues };
}

export function decryptFallbackEntry(
	state: FallbackStoreState,
	name: string,
): string {
	const entry = state.latestByName.get(name);
	if (!entry) throw new SecretMissingError([name]);
	return decryptFallback(entry.ct, entry.nonce, state.key, name);
}
