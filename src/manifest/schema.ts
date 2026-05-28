import { z } from "zod";

const NAME_PATTERN =
	/^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?__[a-z0-9][a-z0-9_]{0,62}[a-z0-9]$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const AUTH_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const ToolName = z
	.string()
	.max(128)
	.regex(NAME_PATTERN, "tool name must match <namespace>__<action> (ADR-005)");

const Tag = z
	.string()
	.max(64)
	.regex(TAG_PATTERN, "tag must be lowercase alphanumeric + dash");

const AuthProfileName = z
	.string()
	.max(64)
	.regex(
		AUTH_PROFILE_PATTERN,
		"authProfile must match ^[a-z0-9][a-z0-9_-]{0,63}$",
	);

const UpstreamMcp = z.object({
	type: z.literal("mcp"),
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	remoteTool: z.string().min(1),
});

const UpstreamRest = z.object({
	type: z.literal("rest"),
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
	url: z.string().min(1),
	headers: z.record(z.string(), z.string()).optional(),
	bodyTemplate: z.unknown().optional(),
});

const UpstreamCli = z.object({
	type: z.literal("cli"),
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	cwd: z.string().optional(),
});

const Upstream = z.discriminatedUnion("type", [
	UpstreamMcp,
	UpstreamRest,
	UpstreamCli,
]);

export const ToolSchema = z
	.object({
		name: ToolName,
		description: z.string().min(1),
		inputSchema: z.record(z.string(), z.unknown()),
		tags: z.array(Tag).min(1),
		upstream: Upstream,
		concurrency: z.number().int().min(1).max(32),
		timeoutMs: z.number().int().min(1).max(600_000),
		retryPolicy: z.enum(["none", "safe-idempotent"]),
		sideEffecting: z.boolean(),
		authProfile: AuthProfileName.optional(),
	})
	.superRefine((tool, ctx) => {
		if (tool.upstream.type === "cli") {
			if (tool.concurrency !== 1) {
				ctx.addIssue({
					code: "custom",
					message: "CLI tool must have concurrency=1 (ADR-004 hard constraint)",
					path: ["concurrency"],
				});
			}
			if (tool.retryPolicy !== "none") {
				ctx.addIssue({
					code: "custom",
					message:
						"CLI tool must have retryPolicy=none (ADR-004 hard constraint)",
					path: ["retryPolicy"],
				});
			}
		}
	});

export const ToolsManifestSchema = z.object({
	$schema: z.string().optional(),
	tools: z.array(ToolSchema).min(1),
});

export const GatewayConfigSchema = z.object({
	toolsPath: z.string().min(1),
	auditPath: z.string().min(1),
	authProfilesPath: z.string().min(1).optional(),
	secrets: z
		.object({
			source: z.enum(["env", "file"]).default("env"),
		})
		.optional(),
	paths: z.record(z.string(), z.string().min(1)).optional(),
	profiles: z
		.record(z.string(), z.array(Tag).min(1))
		.refine((profiles) => Object.keys(profiles).length > 0, {
			message: "at least one profile must be defined",
		}),
});
