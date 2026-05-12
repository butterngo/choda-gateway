export class ManifestError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "ManifestError";
	}
}

export class ProfileError extends Error {
	constructor(
		message: string,
		public readonly profile?: string,
	) {
		super(message);
		this.name = "ProfileError";
	}
}
