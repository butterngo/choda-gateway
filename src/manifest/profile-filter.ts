import { ProfileError } from "./errors.js";
import type { GatewayConfig, Tool } from "./types.js";

export interface ResolveProfileInput {
	cliFlag?: string;
	env?: NodeJS.ProcessEnv;
	config: GatewayConfig;
}

export interface ActiveProfile {
	name: string;
	tags: string[];
}

export function resolveActiveProfile(
	input: ResolveProfileInput,
): ActiveProfile {
	const fromCli = input.cliFlag?.trim();
	const fromEnv = input.env?.GATEWAY_PROFILE?.trim();
	const chosen = fromCli || fromEnv;
	if (!chosen) {
		throw new ProfileError(
			"no active profile — pass --profile=<name> or set GATEWAY_PROFILE",
		);
	}
	const tags = input.config.profiles[chosen];
	if (!tags) {
		const available = Object.keys(input.config.profiles).sort().join(", ");
		throw new ProfileError(
			`profile not found: ${chosen} (available: ${available || "<none>"})`,
			chosen,
		);
	}
	return { name: chosen, tags };
}

export function filterToolsByProfile(
	tools: Tool[],
	profile: ActiveProfile,
): Tool[] {
	const profileTagSet = new Set(profile.tags);
	return tools.filter((tool) =>
		tool.tags.some((tag) => profileTagSet.has(tag)),
	);
}
