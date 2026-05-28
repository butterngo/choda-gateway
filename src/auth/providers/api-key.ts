import type {
	AuthProfile,
	CallContext,
	CredentialProvider,
	ResolvedAuth,
} from "../types.js";

type ApiKeyProfile = Extract<AuthProfile, { type: "api-key" }>;

export function createApiKeyProvider(
	profile: ApiKeyProfile,
): CredentialProvider {
	return {
		type: "api-key",
		async resolve(_ctx: CallContext): Promise<ResolvedAuth> {
			if (profile.location === "header") {
				return { headers: { [profile.name]: profile.value } };
			}
			return { headers: {}, query: { [profile.name]: profile.value } };
		},
	};
}
