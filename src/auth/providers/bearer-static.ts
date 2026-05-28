import type {
	AuthProfile,
	CallContext,
	CredentialProvider,
	ResolvedAuth,
} from "../types.js";

type BearerStaticProfile = Extract<AuthProfile, { type: "bearer-static" }>;

export function createBearerStaticProvider(
	profile: BearerStaticProfile,
): CredentialProvider {
	const resolved: ResolvedAuth = {
		headers: { Authorization: `Bearer ${profile.token}` },
	};
	return {
		type: "bearer-static",
		async resolve(_ctx: CallContext): Promise<ResolvedAuth> {
			return { headers: { ...resolved.headers } };
		},
	};
}
