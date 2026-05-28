import {
	type AuthProfile,
	AuthProfileError,
	type CredentialProvider,
} from "../types.js";
import { createApiKeyProvider } from "./api-key.js";
import { createBearerStaticProvider } from "./bearer-static.js";
import { createCookieJarProvider } from "./cookie-jar.js";
import {
	type ExecInvokeListener,
	createExecScriptProvider,
} from "./exec-script.js";
import { createOAuth2CcProvider } from "./oauth2-cc.js";

export interface CreateProviderOptions {
	/**
	 * Forwarded to providers that emit audit-relevant events (currently
	 * exec-script). Receives one event per subprocess invocation; never
	 * includes stdout, stderr, env, or args beyond the command head.
	 */
	onExecInvoke?: ExecInvokeListener;
}

/**
 * Build a `CredentialProvider` from a validated `AuthProfile`. Dispatch is on
 * `profile.type`; unsupported types throw `AuthProfileError` with the profile
 * name (when known) so the operator can locate the bad entry in
 * `auth-profiles.yaml`.
 */
export function createProvider(
	profile: AuthProfile,
	profileName?: string,
	opts: CreateProviderOptions = {},
): CredentialProvider {
	switch (profile.type) {
		case "bearer-static":
			return createBearerStaticProvider(profile);
		case "api-key":
			return createApiKeyProvider(profile);
		case "oauth2-cc":
			return createOAuth2CcProvider(profile, { profileName });
		case "cookie-jar":
			return createCookieJarProvider(profile, { profileName });
		case "exec-script":
			return createExecScriptProvider(profile, {
				profileName,
				onInvoke: opts.onExecInvoke,
			});
		default: {
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
	opts: CreateProviderOptions = {},
): Map<string, CredentialProvider> {
	const reg = new Map<string, CredentialProvider>();
	for (const [name, profile] of profiles) {
		try {
			reg.set(name, createProvider(profile, name, opts));
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
