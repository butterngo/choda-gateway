export class SecretMissingError extends Error {
	constructor(public readonly names: string[]) {
		super(`secret(s) not found in store: ${names.join(", ")}`);
		this.name = "SecretMissingError";
	}
}

export class DecryptError extends Error {
	constructor(
		public readonly secretName: string,
		public override readonly cause?: unknown,
	) {
		super(`failed to decrypt entry '${secretName}'`);
		this.name = "DecryptError";
	}
}

export class LibsodiumInitError extends Error {
	constructor(public override readonly cause?: unknown) {
		super(
			"libsodium failed to initialise; refusing to fall back unless GATEWAY_ALLOW_CRYPTO_FALLBACK=1",
		);
		this.name = "LibsodiumInitError";
	}
}
