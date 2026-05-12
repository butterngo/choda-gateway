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
	KEY_BYTES,
	NONCE_BYTES,
	SALT_BYTES,
	buildInitialHeader,
	parseEntries,
	readHeader,
} from "./header.js";

export interface SecretStore {
	get(name: string): Promise<string>;
	has(name: string): Promise<boolean>;
	list(): Promise<string[]>;
	maskValue(value: string): boolean;
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

export async function openSecretStore(
	opts: OpenSecretStoreOptions,
): Promise<SecretStore> {
	await ensureSodiumReady();
	const fileBuf = await readFile(opts.storePath);
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

	// Eager-decrypt required secrets to populate the mask set and surface missing/decrypt errors at open time.
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
	if (missing.length > 0) {
		throw new SecretMissingError(missing);
	}

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
	};
}

// ---- helpers for tests / future CLI ---------------------------------------

export interface InitSecretStoreOptions {
	storePath: string;
}

export async function initSecretStore(
	opts: InitSecretStoreOptions,
): Promise<void> {
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
	await ensureSodiumReady();
	const fileBuf = await readFile(opts.storePath);
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
	await appendFile(opts.storePath, line);
}
