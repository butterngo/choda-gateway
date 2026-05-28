import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import sodium from "libsodium-wrappers-sumo";
import {
	DecryptError,
	LibsodiumInitError,
	SecretMissingError,
} from "./errors.js";
import {
	FALLBACK_MAGIC,
	decryptFallbackEntry,
	initFallbackStore,
	loadFallbackStore,
	setFallbackSecret,
} from "./fallback.js";
import {
	KEY_BYTES,
	MAGIC,
	NONCE_BYTES,
	SALT_BYTES,
	buildInitialHeader,
	parseEntries,
	readHeader,
} from "./header.js";
import { withStoreWriteLock } from "./locks.js";

export type CryptoBackend = "libsodium" | "node:crypto";

export interface SecretStore {
	get(name: string): Promise<string>;
	has(name: string): Promise<boolean>;
	list(): Promise<string[]>;
	maskValue(value: string): boolean;
	/**
	 * Iterable of every plaintext secret value loaded so far (required at open()
	 * plus any value materialised by lazy get()). Consumed by the audit logger
	 * to mask substring occurrences in log lines.
	 */
	maskedValues(): Iterable<string>;
	/**
	 * Which crypto backend produced this store. "libsodium" for CGSS01 files
	 * (Argon2id + XChaCha20-Poly1305), "node:crypto" for CGSS02 (scrypt + AES-256-GCM).
	 * Surfaces the choice so the operator can see when fallback is in play.
	 */
	readonly cryptoBackend: CryptoBackend;
}

export interface OpenSecretStoreOptions {
	storePath: string;
	password: string;
	required: string[];
}

let readyPromise: Promise<void> | null = null;
async function ensureSodiumReady(): Promise<void> {
	if (readyPromise === null) {
		readyPromise = (async () => {
			try {
				await sodium.ready;
			} catch (cause) {
				readyPromise = null;
				throw new LibsodiumInitError(cause);
			}
		})();
	}
	return readyPromise;
}

async function deriveKey(
	password: string,
	salt: Buffer,
	opslimit: number,
	memlimit: number,
): Promise<Buffer> {
	await ensureSodiumReady();
	return Buffer.from(
		sodium.crypto_pwhash(
			KEY_BYTES,
			password,
			salt,
			opslimit,
			memlimit,
			sodium.crypto_pwhash_ALG_ARGON2ID13,
		),
	);
}

function decryptEntry(
	ctB64: string,
	nonceB64: string,
	key: Buffer,
	name: string,
): string {
	const nonce = Buffer.from(nonceB64, "base64");
	const ct = Buffer.from(ctB64, "base64");
	try {
		const pt = Buffer.from(
			sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
				null,
				ct,
				null,
				nonce,
				key,
			),
		);
		return pt.toString("utf8");
	} catch (cause) {
		throw new DecryptError(name, cause);
	}
}

function readMagic(fileBuf: Buffer): "libsodium" | "fallback" | "unknown" {
	if (fileBuf.length < 6) return "unknown";
	const m = fileBuf.subarray(0, 6);
	if (m.equals(MAGIC)) return "libsodium";
	if (m.equals(FALLBACK_MAGIC)) return "fallback";
	return "unknown";
}

async function openLibsodiumStore(
	opts: OpenSecretStoreOptions,
	fileBuf: Buffer,
): Promise<SecretStore> {
	await ensureSodiumReady();
	const { kdfParams, salt, entriesText } = readHeader(fileBuf);
	const entries = parseEntries(entriesText);
	const latestByName = new Map<string, { ct: string; nonce: string }>();
	for (const e of entries) {
		latestByName.set(e.name, { ct: e.ct, nonce: e.nonce });
	}

	const key = await deriveKey(
		opts.password,
		salt,
		kdfParams.opslimit,
		kdfParams.memlimit,
	);

	const missing: string[] = [];
	const maskedValues = new Set<string>();
	for (const name of opts.required) {
		const entry = latestByName.get(name);
		if (!entry) {
			missing.push(name);
			continue;
		}
		const value = decryptEntry(entry.ct, entry.nonce, key, name);
		maskedValues.add(value);
	}
	if (missing.length > 0) throw new SecretMissingError(missing);

	return {
		async get(name: string): Promise<string> {
			const entry = latestByName.get(name);
			if (!entry) throw new SecretMissingError([name]);
			const value = decryptEntry(entry.ct, entry.nonce, key, name);
			maskedValues.add(value);
			return value;
		},
		async has(name: string): Promise<boolean> {
			return latestByName.has(name);
		},
		async list(): Promise<string[]> {
			return [...latestByName.keys()];
		},
		maskValue(value: string): boolean {
			return value.length > 0 && maskedValues.has(value);
		},
		maskedValues(): Iterable<string> {
			return maskedValues;
		},
		cryptoBackend: "libsodium",
	};
}

async function openFallbackSecretStore(
	opts: OpenSecretStoreOptions,
): Promise<SecretStore> {
	const state = await loadFallbackStore(opts);
	const { latestByName, maskedValues } = state;
	return {
		async get(name: string): Promise<string> {
			const value = decryptFallbackEntry(state, name);
			maskedValues.add(value);
			return value;
		},
		async has(name: string): Promise<boolean> {
			return latestByName.has(name);
		},
		async list(): Promise<string[]> {
			return [...latestByName.keys()];
		},
		maskValue(value: string): boolean {
			return value.length > 0 && maskedValues.has(value);
		},
		maskedValues(): Iterable<string> {
			return maskedValues;
		},
		cryptoBackend: "node:crypto",
	};
}

/**
 * Open a secret store. The MAGIC bytes at the file head decide which crypto
 * backend is used:
 *   - CGSS01 → libsodium (Argon2id + XChaCha20-Poly1305). Requires
 *     `await sodium.ready` to succeed; throws `LibsodiumInitError` if not.
 *   - CGSS02 → node:crypto fallback (scrypt + AES-256-GCM). Always available.
 * The cipher choice is visible on `store.cryptoBackend`.
 */
export async function openSecretStore(
	opts: OpenSecretStoreOptions,
): Promise<SecretStore> {
	const fileBuf = await readFile(opts.storePath);
	const which = readMagic(fileBuf);
	if (which === "libsodium") return openLibsodiumStore(opts, fileBuf);
	if (which === "fallback") return openFallbackSecretStore(opts);
	throw new Error(
		`unrecognised secret-store MAGIC (file=${opts.storePath}); expected CGSS01 or CGSS02`,
	);
}

// ---- init + set helpers (used by tests + future CLI) ----------------------

export interface InitSecretStoreOptions {
	storePath: string;
	/**
	 * Which backend to use for a freshly-created store. Defaults to `libsodium`.
	 * Pass `node:crypto` (or set `GATEWAY_ALLOW_CRYPTO_FALLBACK=1` and let the
	 * caller decide) only when libsodium is unavailable on the host.
	 */
	backend?: CryptoBackend;
}

export async function initSecretStore(
	opts: InitSecretStoreOptions,
): Promise<void> {
	const backend: CryptoBackend = opts.backend ?? "libsodium";
	if (backend === "node:crypto") {
		await initFallbackStore({ storePath: opts.storePath });
		return;
	}
	await ensureSodiumReady();
	if (existsSync(opts.storePath)) {
		throw new Error(`store already exists at ${opts.storePath}`);
	}
	const opslimit = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE;
	const memlimit = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE;
	const salt = Buffer.from(sodium.randombytes_buf(SALT_BYTES));
	await writeFile(opts.storePath, buildInitialHeader(opslimit, memlimit, salt));
}

export interface SetSecretOptions {
	storePath: string;
	password: string;
	name: string;
	value: string;
}

export async function setSecret(opts: SetSecretOptions): Promise<void> {
	const fileBuf = await readFile(opts.storePath);
	const which = readMagic(fileBuf);
	if (which === "fallback") {
		await setFallbackSecret(opts);
		return;
	}
	if (which !== "libsodium") {
		throw new Error(
			`unrecognised store MAGIC for setSecret: ${opts.storePath}`,
		);
	}
	await ensureSodiumReady();
	const { kdfParams, salt } = readHeader(fileBuf);
	const key = await deriveKey(
		opts.password,
		salt,
		kdfParams.opslimit,
		kdfParams.memlimit,
	);
	const nonce = Buffer.from(sodium.randombytes_buf(NONCE_BYTES));
	const ct = Buffer.from(
		sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			Buffer.from(opts.value, "utf8"),
			null,
			null,
			nonce,
			key,
		),
	);
	const line = `${JSON.stringify({
		name: opts.name,
		nonce: nonce.toString("base64"),
		ct: ct.toString("base64"),
	})}\n`;
	// Serialise the final append so parallel setSecret calls on the same store
	// can't race the file pointer (Windows NTFS — TASK-976).
	await withStoreWriteLock(opts.storePath, () =>
		appendFile(opts.storePath, line),
	);
}
