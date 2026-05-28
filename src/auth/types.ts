import { z } from "zod";

export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const ProfileName = z
	.string()
	.regex(
		PROFILE_NAME_PATTERN,
		"profile name must match ^[a-z0-9][a-z0-9_-]{0,63}$",
	);

const BearerStaticProfile = z.object({
	type: z.literal("bearer-static"),
	description: z.string().optional(),
	token: z.string().min(1),
});

const ApiKeyProfile = z.object({
	type: z.literal("api-key"),
	description: z.string().optional(),
	location: z.enum(["header", "query"]),
	name: z.string().min(1),
	value: z.string().min(1),
});

const OAuth2ClientCredentialsProfile = z.object({
	type: z.literal("oauth2-cc"),
	description: z.string().optional(),
	tokenUrl: z.string().refine(
		(v) => {
			try {
				const u = new URL(v);
				if (u.protocol === "https:") return true;
				return (
					u.protocol === "http:" &&
					(u.hostname === "localhost" || u.hostname === "127.0.0.1")
				);
			} catch {
				return false;
			}
		},
		{ message: "tokenUrl must be https:// (or http://localhost for testing)" },
	),
	clientId: z.string().min(1),
	clientSecret: z.string().min(1),
	scope: z.string().optional(),
	audience: z.string().optional(),
	clientAuth: z.enum(["basic", "body"]).default("basic"),
});

const CookieJarProfile = z.object({
	type: z.literal("cookie-jar"),
	description: z.string().optional(),
	cookieFile: z.string().min(1),
	forwardHeaders: z.array(z.string().min(1)).default(["cookie"]),
	extraHeaders: z.record(z.string(), z.string()).optional(),
});

const ExecScriptProfile = z.object({
	type: z.literal("exec-script"),
	description: z.string().optional(),
	command: z.array(z.string().min(1)).min(1),
	cwd: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
	cacheTtlSeconds: z.number().int().min(1),
	timeoutMs: z.number().int().min(1).max(600_000).default(30_000),
	headerTemplate: z.record(z.string(), z.string()).optional(),
	parseOutputAs: z.enum(["raw", "json"]).default("raw"),
});

export const AuthProfileSchema = z.discriminatedUnion("type", [
	BearerStaticProfile,
	ApiKeyProfile,
	OAuth2ClientCredentialsProfile,
	CookieJarProfile,
	ExecScriptProfile,
]);

export const AuthProfilesFileSchema = z.object({
	profiles: z
		.record(ProfileName, AuthProfileSchema)
		.refine((p) => Object.keys(p).length > 0, {
			message: "at least one profile must be defined",
		}),
});

export type AuthProfile = z.infer<typeof AuthProfileSchema>;
export type AuthProfilesFile = z.infer<typeof AuthProfilesFileSchema>;
export type ProviderType = AuthProfile["type"];

export interface ResolvedAuth {
	headers: Record<string, string>;
	query?: Record<string, string>;
}

export interface CallContext {
	toolName: string;
	correlationId?: string;
}

export interface CredentialProvider {
	readonly type: ProviderType;
	resolve(ctx: CallContext): Promise<ResolvedAuth>;
	dispose?(): Promise<void>;
}

export class AuthProfileError extends Error {
	constructor(
		message: string,
		public readonly profile?: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "AuthProfileError";
	}
}

export class AuthResolveError extends Error {
	constructor(
		message: string,
		public readonly profile: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "AuthResolveError";
	}
}
