import { Buffer } from "node:buffer";

export const MAGIC = Buffer.from("CGSS01", "ascii");
export const KDF_PARAMS_BYTES = 16;
export const SALT_BYTES = 16;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const HEADER_FIXED_END = MAGIC.length + KDF_PARAMS_BYTES + SALT_BYTES; // 38

export interface KdfParams {
	opslimit: number;
	memlimit: number;
}

export interface ParsedHeader {
	kdfParams: KdfParams;
	salt: Buffer;
	entriesText: string;
}

export interface RawEntry {
	name: string;
	nonce: string;
	ct: string;
}

export function packKdfParams(opslimit: number, memlimit: number): Buffer {
	const buf = Buffer.alloc(KDF_PARAMS_BYTES);
	buf.writeBigUInt64LE(BigInt(opslimit), 0);
	buf.writeBigUInt64LE(BigInt(memlimit), 8);
	return buf;
}

export function unpackKdfParams(buf: Buffer): KdfParams {
	return {
		opslimit: Number(buf.readBigUInt64LE(0)),
		memlimit: Number(buf.readBigUInt64LE(8)),
	};
}

export function readHeader(fileBuf: Buffer): ParsedHeader {
	if (fileBuf.length < HEADER_FIXED_END) {
		throw new Error(
			`file too short to be a valid store (${fileBuf.length} bytes)`,
		);
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

export function parseEntries(text: string): RawEntry[] {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RawEntry);
}

export function buildInitialHeader(
	opslimit: number,
	memlimit: number,
	salt: Buffer,
): Buffer {
	return Buffer.concat([
		MAGIC,
		packKdfParams(opslimit, memlimit),
		salt,
		Buffer.from("\n", "ascii"),
	]);
}
