import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { SecretStore } from "../secrets/store.js";
import {
	type AuthProfile,
	AuthProfileError,
	AuthProfilesFileSchema,
	type ProviderType,
} from "./types.js";

export interface LoadProfilesOptions {
	yamlPath: string;
	/**
	 * Required when any profile references `${secret:KEY}`. The loader will call
	 * `has` first to give a clean error on unknown names, then `get` to
	 * materialise the plaintext.
	 */
	secretStore?: Pick<SecretStore, "has" | "get">;
	/**
	 * Lookup table for `${path:KEY}` substitution. Typically sourced from
	 * `gateway.config.yaml > paths`. Empty/undefined makes any path reference
	 * fail with a clear "missing path key" error.
	 */
	paths?: Record<string, string>;
}

export interface LoadProfilesResult {
	profiles: Map<string, AuthProfile>;
	warnings: string[];
}

const SECRET_PLACEHOLDER = /\$\{secret:([A-Za-z][A-Za-z0-9_]*)\}/g;
const PATH_PLACEHOLDER = /\$\{path:([A-Za-z][A-Za-z0-9_]*)\}/g;
const ANY_PLACEHOLDER = /\$\{([a-zA-Z]+):([^}]+)\}/g;

const SENSITIVE_FIELDS: Record<ProviderType, string[]> = {
	"bearer-static": ["token"],
	"api-key": ["value"],
	"oauth2-cc": ["clientSecret"],
	"cookie-jar": [],
	"exec-script": [],
};

export async function loadProfiles(
	opts: LoadProfilesOptions,
): Promise<LoadProfilesResult> {
	let raw: string;
	try {
		raw = await readFile(opts.yamlPath, "utf8");
	} catch (cause) {
		throw new AuthProfileError(
			`cannot read auth profiles file: ${opts.yamlPath}`,
			undefined,
			cause,
		);
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (cause) {
		throw new AuthProfileError(
			`malformed YAML in ${opts.yamlPath}`,
			undefined,
			cause,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new AuthProfileError(
			`auth profiles file must be a YAML object: ${opts.yamlPath}`,
		);
	}

	const substitutedSecretPaths = new Set<string>();
	const substituted = await substituteAsync(parsed, "", {
		secretStore: opts.secretStore,
		paths: opts.paths ?? {},
		onSecretSubstitution: (path) => substitutedSecretPaths.add(path),
	});

	const result = AuthProfilesFileSchema.safeParse(substituted);
	if (!result.success) {
		throw new AuthProfileError(
			`auth profiles validation failed:\n${formatIssues(result.error.issues)}`,
			undefined,
			result.error,
		);
	}

	const warnings: string[] = [];
	const profiles = new Map<string, AuthProfile>();
	for (const [name, profile] of Object.entries(result.data.profiles)) {
		profiles.set(name, profile);
		const sensitive = SENSITIVE_FIELDS[profile.type] ?? [];
		for (const field of sensitive) {
			const fullPath = `profiles.${name}.${field}`;
			if (!substitutedSecretPaths.has(fullPath)) {
				warnings.push(
					`profile '${name}': field '${field}' has a plaintext value — consider \${secret:KEY} (file is committed; secrets should not be inlined)`,
				);
			}
		}
	}

	return { profiles, warnings };
}

interface SubstituteOptions {
	secretStore?: Pick<SecretStore, "has" | "get">;
	paths: Record<string, string>;
	onSecretSubstitution: (path: string) => void;
}

async function substituteAsync(
	value: unknown,
	path: string,
	opts: SubstituteOptions,
): Promise<unknown> {
	if (typeof value === "string") {
		return substituteString(value, path, opts);
	}
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (let i = 0; i < value.length; i++) {
			out.push(await substituteAsync(value[i], `${path}[${i}]`, opts));
		}
		return out;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const childPath = path ? `${path}.${k}` : k;
			out[k] = await substituteAsync(v, childPath, opts);
		}
		return out;
	}
	return value;
}

async function substituteString(
	original: string,
	path: string,
	opts: SubstituteOptions,
): Promise<string> {
	// Reject unknown placeholder kinds up front (e.g. ${foo:bar}).
	for (const m of original.matchAll(ANY_PLACEHOLDER)) {
		if (m[1] !== "secret" && m[1] !== "path") {
			throw new AuthProfileError(
				`unknown placeholder kind '${m[1]}' at ${path} (expected secret or path)`,
			);
		}
	}

	let result = original;
	let hadSecret = false;

	for (const m of original.matchAll(SECRET_PLACEHOLDER)) {
		const key = m[1];
		if (!opts.secretStore) {
			throw new AuthProfileError(
				`cannot resolve \${secret:${key}} at ${path}: no secret store available`,
			);
		}
		const exists = await opts.secretStore.has(key);
		if (!exists) {
			throw new AuthProfileError(
				`unknown secret '${key}' referenced at ${path}`,
			);
		}
		const value = await opts.secretStore.get(key);
		result = result.split(m[0]).join(value);
		hadSecret = true;
	}

	for (const m of original.matchAll(PATH_PLACEHOLDER)) {
		const key = m[1];
		const resolved = opts.paths[key];
		if (resolved === undefined) {
			throw new AuthProfileError(
				`unknown path key '${key}' referenced at ${path} — declare it in gateway.config.yaml > paths`,
			);
		}
		result = result.split(m[0]).join(resolved);
	}

	if (hadSecret) {
		opts.onSecretSubstitution(path);
	}

	return result;
}

/**
 * Scan an auth-profiles.yaml without resolving secrets. Returns the set of
 * `${secret:KEY}` names that need to be available at startup. Used by the CLI
 * to populate `openSecretStore({ required })` before passing the store to
 * `loadProfiles`.
 */
export async function collectProfileSecretRefs(
	yamlPath: string,
): Promise<string[]> {
	const raw = await readFile(yamlPath, "utf8");
	const names = new Set<string>();
	for (const m of raw.matchAll(SECRET_PLACEHOLDER)) {
		names.add(m[1]);
	}
	return [...names].sort();
}

function formatIssues(
	issues: { path: PropertyKey[]; message: string }[],
): string {
	return issues
		.map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
		.join("\n");
}
