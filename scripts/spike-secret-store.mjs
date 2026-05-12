// Spike-5 core: minimal libsodium-backed secret store
// File format (`secrets.enc`):
//   [ MAGIC: "CGSS01" 6 bytes ]
//   [ KDF_PARAMS: 16 bytes ] (opslimit uint64 LE + memlimit uint64 LE)
//   [ SALT: 16 bytes ]
//   [ '\n' separator ]
//   [ ENTRIES: JSONL { name, nonce(b64), ct(b64) } ]
//
// Cipher: XChaCha20-Poly1305 IETF (key 32B, nonce 24B, random per-entry).
// KDF: Argon2id via crypto_pwhash (opslimit + memlimit baked into header).

import sodium from "libsodium-wrappers-sumo";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";

const MAGIC = Buffer.from("CGSS01", "ascii"); // 6 bytes
const KDF_PARAMS_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const HEADER_FIXED_END = MAGIC.length + KDF_PARAMS_BYTES + SALT_BYTES; // 38

export class DecryptError extends Error {
	constructor(message) {
		super(message);
		this.name = "DecryptError";
	}
}

let ready = false;
async function ensureReady() {
	if (!ready) {
		await sodium.ready;
		ready = true;
	}
}

function packKdfParams(opslimit, memlimit) {
	const buf = Buffer.alloc(KDF_PARAMS_BYTES);
	buf.writeBigUInt64LE(BigInt(opslimit), 0);
	buf.writeBigUInt64LE(BigInt(memlimit), 8);
	return buf;
}

function unpackKdfParams(buf) {
	return {
		opslimit: Number(buf.readBigUInt64LE(0)),
		memlimit: Number(buf.readBigUInt64LE(8)),
	};
}

async function deriveKey(password, salt, opslimit, memlimit) {
	await ensureReady();
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

function readHeader(filepath) {
	const fileBuf = readFileSync(filepath);
	if (fileBuf.length < HEADER_FIXED_END) {
		throw new Error(`file too short to be a valid store: ${filepath}`);
	}
	const magic = fileBuf.subarray(0, MAGIC.length);
	if (!magic.equals(MAGIC)) {
		throw new Error(
			`bad magic: expected ${MAGIC.toString()}, got ${magic.toString()}`,
		);
	}
	const kdfParams = unpackKdfParams(
		fileBuf.subarray(MAGIC.length, MAGIC.length + KDF_PARAMS_BYTES),
	);
	const salt = Buffer.from(
		fileBuf.subarray(MAGIC.length + KDF_PARAMS_BYTES, HEADER_FIXED_END),
	);
	let pos = HEADER_FIXED_END;
	if (fileBuf[pos] === 0x0a) pos++;
	const entriesText = fileBuf.subarray(pos).toString("utf8");
	return { kdfParams, salt, entriesText };
}

function parseEntries(text) {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

export async function init(filepath, _password) {
	await ensureReady();
	if (existsSync(filepath)) {
		throw new Error(`store already exists at ${filepath}`);
	}
	const opslimit = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE;
	const memlimit = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE;
	const salt = Buffer.from(sodium.randombytes_buf(SALT_BYTES));
	const header = Buffer.concat([
		MAGIC,
		packKdfParams(opslimit, memlimit),
		salt,
		Buffer.from("\n", "ascii"),
	]);
	writeFileSync(filepath, header);
}

export async function setSecret(filepath, password, name, value) {
	await ensureReady();
	const { kdfParams, salt } = readHeader(filepath);
	const key = await deriveKey(
		password,
		salt,
		kdfParams.opslimit,
		kdfParams.memlimit,
	);
	const nonce = Buffer.from(sodium.randombytes_buf(NONCE_BYTES));
	const ct = Buffer.from(
		sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
			Buffer.from(value, "utf8"),
			null,
			null,
			nonce,
			key,
		),
	);
	const entry = {
		name,
		nonce: nonce.toString("base64"),
		ct: ct.toString("base64"),
	};
	appendFileSync(filepath, `${JSON.stringify(entry)}\n`);
}

export async function getSecret(filepath, password, name) {
	await ensureReady();
	const { kdfParams, salt, entriesText } = readHeader(filepath);
	const key = await deriveKey(
		password,
		salt,
		kdfParams.opslimit,
		kdfParams.memlimit,
	);
	const entries = parseEntries(entriesText);
	const entry = entries
		.slice()
		.reverse()
		.find((e) => e.name === name);
	if (!entry) throw new Error(`secret not found: ${name}`);
	const nonce = Buffer.from(entry.nonce, "base64");
	const ct = Buffer.from(entry.ct, "base64");
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
	} catch (err) {
		throw new DecryptError(
			`failed to decrypt entry '${name}': ${err.message ?? err}`,
		);
	}
}

export async function listSecrets(filepath) {
	await ensureReady();
	const { entriesText } = readHeader(filepath);
	const entries = parseEntries(entriesText);
	return [...new Set(entries.map((e) => e.name))];
}
