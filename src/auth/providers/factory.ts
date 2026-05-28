import {
	type AuthProfile,
	AuthProfileError,
	type CredentialProvider,
} from "../types.js";
import { createApiKeyProvider } from "./api-key.js";
import { createBearerStaticProvider } from "./bearer-static.js";

/**
 * Build a `CredentialProvider` from a validated `AuthProfile`. Dispatch is on
 * `profile.type`; unsupported types throw `AuthProfileError` with the profile
 * name (when known) so the operator can locate the bad entry in
 * `auth-profiles.yaml`.
 *
 * Each subsequent ADR-006 task (TASK-961..963) registers its provider here.
 */
export function createProvider(
	profile: AuthProfile,
	profileName?: string,
): CredentialProvider {
	switch (profile.type) {
		case "bearer-static":
			return createBearerStaticProvider(profile);
		case "api-key":
			return createApiKeyProvider(profile);
		default: {
			// Provider types declared in the schema but not yet wired.
			const t = (profile as { type: string }).type;
			throw new AuthProfileError(
				`provider type '${t}' is not yet implemented`,
				profileName,
			);
		}
	}
}

/**
 * Build a registry of `CredentialProvider`s keyed by profile name, given the
 * map produced by `loadProfiles()`. Errors include the profile name so a
 * bad entry can be located.
 */
export function createProviderRegistry(
	profiles: ReadonlyMap<string, AuthProfile>,
): Map<string, CredentialProvider> {
	const reg = new Map<string, CredentialProvider>();
	for (const [name, profile] of profiles) {
		try {
			reg.set(name, createProvider(profile, name));
		} catch (cause) {
			if (cause instanceof AuthProfileError) throw cause;
			throw new AuthProfileError(
				`failed to instantiate provider for profile '${name}'`,
				name,
				cause,
			);
		}
	}
	return reg;
}
