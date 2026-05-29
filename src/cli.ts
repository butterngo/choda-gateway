#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createAuditLogger } from "./audit/logger.js";
import { collectProfileSecretRefs, loadProfiles } from "./auth/profiles.js";
import { createProviderRegistry } from "./auth/providers/factory.js";
import type { CredentialProvider } from "./auth/types.js";
import { buildMcpServer, startStdioServer } from "./index.js";
import { runIngest } from "./ingest/cli.js";
import {
	assertAuthProfilesReferenced,
	loadGatewayConfig,
	loadToolsManifest,
} from "./manifest/loader.js";
import {
	filterToolsByProfile,
	resolveActiveProfile,
} from "./manifest/profile-filter.js";
import type { Tool } from "./manifest/types.js";
import { type Router, createRouter } from "./router.js";
import { removeSecret } from "./secrets/remove.js";
import {
	initSecretStore,
	openSecretStore,
	setSecret,
} from "./secrets/store.js";

const DEFAULT_CONFIG_PATH = "./gateway.config.yaml";
const PASSWORD_ENV = "GATEWAY_SECRETS_PASSWORD";

interface ParsedCli {
	values: {
		profile?: string;
		config?: string;
		help?: boolean;
		value?: string;
		group?: string;
		"auth-profile"?: string;
		out?: string;
		"base-url"?: string;
		check?: boolean;
	};
	positionals: string[];
}

function parseCli(argv: string[]): ParsedCli {
	return parseArgs({
		args: argv,
		options: {
			profile: { type: "string" },
			config: { type: "string" },
			value: { type: "string" },
			help: { type: "boolean", short: "h" },
			group: { type: "string" },
			"auth-profile": { type: "string" },
			out: { type: "string" },
			"base-url": { type: "string" },
			check: { type: "boolean" },
		},
		allowPositionals: true,
		strict: true,
	});
}

function printHelp(): void {
	process.stdout.write(
		[
			"choda-gateway — universal MCP/REST/CLI tool gateway",
			"",
			"Usage:",
			"  choda-gateway start [--profile=<name>] [--config=<path>]",
			"  choda-gateway tools list [--profile=<name>] [--config=<path>]",
			"  choda-gateway secrets list [--config=<path>]",
			"  choda-gateway secrets set <NAME> [--value=<val>] [--config=<path>]",
			"  choda-gateway secrets rm <NAME> [--config=<path>]",
			"  choda-gateway ingest <spec> --group=<name> [--auth-profile=<name>]",
			"                         [--out=<path>] [--base-url=<url>] [--check]",
			"",
			"Ingest (OpenAPI → manifest fragment):",
			"  Supported methods : GET POST PUT PATCH DELETE",
			"  Body content type : application/json (multipart/binary skipped + warned)",
			"  Parameters        : path, query, header (cookie params dropped)",
			"  $ref              : local refs only; remote $ref → operation skipped",
			"  Skipped + warned  : callbacks, webhooks, streaming response types",
			"",
			"Environment:",
			`  ${PASSWORD_ENV} — password for the libsodium secret store`,
			"  GATEWAY_PROFILE       — fallback when --profile is not passed",
			"",
		].join("\n"),
	);
}

async function loadAll(configPath: string): Promise<{
	config: Awaited<ReturnType<typeof loadGatewayConfig>>;
	tools: Tool[];
}> {
	const config = await loadGatewayConfig(configPath);
	const manifest = await loadToolsManifest(config.resolvedToolsPath);
	return { config, tools: manifest.tools };
}

function requirePassword(): string {
	const pw = process.env[PASSWORD_ENV];
	if (!pw) {
		throw new Error(`${PASSWORD_ENV} env var is required`);
	}
	return pw;
}

function resolveSecretsPath(configDir: string): string {
	// The audit + manifest paths come from config; the secrets file lives
	// alongside as `secrets.enc` until a dedicated config field lands.
	return `${configDir.replace(/\\/g, "/")}/secrets.enc`;
}

async function cmdStart(cli: ParsedCli): Promise<Router> {
	const configPath = cli.values.config ?? DEFAULT_CONFIG_PATH;
	const { config, tools } = await loadAll(configPath);
	const profile = resolveActiveProfile({
		cliFlag: cli.values.profile,
		env: process.env,
		config: config.config,
	});
	const filtered = filterToolsByProfile(tools, profile);
	if (filtered.length === 0) {
		throw new Error(
			`profile '${profile.name}' matches zero tools — check tag intersection`,
		);
	}

	const profilesPath = config.resolvedAuthProfilesPath;
	if (!profilesPath) {
		const toolsNeedingProfile = filtered.filter((t) => t.authProfile);
		if (toolsNeedingProfile.length > 0) {
			const refs = toolsNeedingProfile
				.map((t) => `${t.name} -> ${t.authProfile}`)
				.join("; ");
			throw new Error(
				`tool(s) declare authProfile but gateway.config.yaml has no authProfilesPath: ${refs}`,
			);
		}
	}

	const secretsPath = resolveSecretsPath(config.configDir);
	const requiredFromTools = collectAllSecretRefs(filtered);
	const requiredFromProfiles = profilesPath
		? await collectProfileSecretRefs(profilesPath)
		: [];
	const requiredSecrets = [
		...new Set([...requiredFromTools, ...requiredFromProfiles]),
	].sort();
	let store: Awaited<ReturnType<typeof openSecretStore>>;
	if (!existsSync(secretsPath) && requiredSecrets.length === 0) {
		// No secrets needed and no store on disk — synthesise an empty store.
		store = makeEmptyStore();
	} else {
		const password = requirePassword();
		store = await openSecretStore({
			storePath: secretsPath,
			password,
			required: requiredSecrets,
		});
	}

	let credentialProviders: ReadonlyMap<string, CredentialProvider> | undefined;
	if (profilesPath) {
		const { profiles, warnings } = await loadProfiles({
			yamlPath: profilesPath,
			secretStore: store,
		});
		for (const w of warnings) {
			process.stderr.write(`warn: ${w}\n`);
		}
		credentialProviders = createProviderRegistry(profiles);
		assertAuthProfilesReferenced(
			{ tools: filtered },
			new Set(credentialProviders.keys()),
		);
	}

	const auditLogger = createAuditLogger({
		filepath: config.resolvedAuditPath,
		secretStore: store,
	});

	const router = await createRouter({
		tools: filtered,
		secretStore: store,
		auditLogger,
		profile: profile.name,
		credentialProviders,
	});

	const server = buildMcpServer({ router });
	await startStdioServer(server);
	process.stderr.write(
		`choda-gateway ready: profile=${profile.name} tools=${filtered.length}\n`,
	);

	return router;
}

function collectAllSecretRefs(tools: Tool[]): string[] {
	const placeholder = /\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/g;
	const names = new Set<string>();
	for (const tool of tools) {
		walk(tool.upstream as unknown);
	}
	function walk(value: unknown): void {
		if (typeof value === "string") {
			for (const match of value.matchAll(placeholder)) {
				names.add(match[1]);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const v of value) walk(v);
			return;
		}
		if (value !== null && typeof value === "object") {
			for (const v of Object.values(value as Record<string, unknown>)) walk(v);
		}
	}
	return [...names].sort();
}

function makeEmptyStore(): Awaited<ReturnType<typeof openSecretStore>> {
	return {
		async get(name) {
			throw new Error(`secret missing: ${name}`);
		},
		async has() {
			return false;
		},
		async list() {
			return [];
		},
		maskValue() {
			return false;
		},
		maskedValues() {
			return [] as Iterable<string>;
		},
	};
}

async function cmdToolsList(cli: ParsedCli): Promise<void> {
	const configPath = cli.values.config ?? DEFAULT_CONFIG_PATH;
	const { config, tools } = await loadAll(configPath);
	const profile = cli.values.profile
		? resolveActiveProfile({
				cliFlag: cli.values.profile,
				env: process.env,
				config: config.config,
			})
		: null;
	const list = profile ? filterToolsByProfile(tools, profile) : tools;
	for (const t of list) {
		process.stdout.write(
			`${t.name}\t${t.upstream.type}\t[${t.tags.join(",")}]\t${t.description}\n`,
		);
	}
}

async function cmdSecretsList(cli: ParsedCli): Promise<void> {
	const { storePath } = secretsCtx(cli);
	if (!existsSync(storePath)) {
		process.stdout.write("(no secrets store yet)\n");
		return;
	}
	const password = requirePassword();
	const store = await openSecretStore({
		storePath,
		password,
		required: [],
	});
	const names = await store.list();
	for (const n of names) process.stdout.write(`${n}\n`);
}

async function cmdSecretsSet(cli: ParsedCli, name: string): Promise<void> {
	if (!name) throw new Error("secrets set: NAME positional required");
	const value = cli.values.value ?? (await readStdin()).trim();
	if (!value) throw new Error("secrets set: empty value");
	const { storePath } = secretsCtx(cli);
	const password = requirePassword();
	if (!existsSync(storePath)) {
		await initSecretStore({ storePath });
	}
	await setSecret({ storePath, password, name, value });
	process.stdout.write(`set ${name}\n`);
}

async function cmdSecretsRm(cli: ParsedCli, name: string): Promise<void> {
	if (!name) throw new Error("secrets rm: NAME positional required");
	const { storePath } = secretsCtx(cli);
	if (!existsSync(storePath)) {
		process.stderr.write("no secrets store yet\n");
		process.exit(1);
	}
	const removed = await removeSecret({ storePath, name });
	if (!removed) {
		process.stderr.write(`secret not found: ${name}\n`);
		process.exit(1);
	}
	process.stdout.write(`removed ${name}\n`);
}

function secretsCtx(cli: ParsedCli): { storePath: string } {
	const configPath = cli.values.config ?? DEFAULT_CONFIG_PATH;
	if (!existsSync(configPath)) {
		throw new Error(`config not found: ${configPath}`);
	}
	// loadGatewayConfig() is async; for the secrets subcommand we only need
	// the configDir, which is the dirname of the config path. Resolve cheaply.
	const dir = configPath.replace(/[\\/][^\\/]+$/, "") || ".";
	return { storePath: resolveSecretsPath(dir) };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const cli = parseCli(argv);
	if (cli.values.help || cli.positionals.length === 0) {
		printHelp();
		return;
	}
	const [cmd, ...rest] = cli.positionals;
	switch (cmd) {
		case "start":
			await cmdStart(cli);
			// Keep the event loop alive. Some MCP clients (e.g. Claude Desktop on
			// Windows) close their stdin pipe after the handshake, which lets the
			// MCP SDK's stdio transport release its 'data' listener and the Node
			// process drains the loop and exits 0. The transport itself stays
			// usable for outgoing messages, so we just need to prevent the early
			// exit. The promise never resolves; the host kills us via SIGTERM/exit.
			await new Promise<never>(() => {});
			return;
		case "tools":
			if (rest[0] !== "list") throw new Error(`unknown tools sub: ${rest[0]}`);
			await cmdToolsList(cli);
			return;
		case "secrets":
			switch (rest[0]) {
				case "list":
					return cmdSecretsList(cli);
				case "set":
					return cmdSecretsSet(cli, rest[1]);
				case "rm":
					return cmdSecretsRm(cli, rest[1]);
				default:
					throw new Error(`unknown secrets sub: ${rest[0]}`);
			}
		case "ingest":
			await cmdIngest(cli, rest[0]);
			return;
		default:
			throw new Error(`unknown command: ${cmd}`);
	}
}

async function cmdIngest(cli: ParsedCli, specPath: string): Promise<void> {
	if (!specPath) throw new Error("ingest: spec path required");
	const group = cli.values.group;
	if (!group) throw new Error("ingest: --group=<name> required");
	const result = await runIngest({
		specPath,
		group,
		authProfile: cli.values["auth-profile"],
		outPath: cli.values.out,
		baseUrl: cli.values["base-url"],
		check: cli.values.check,
	});
	if (result.exitCode !== 0) process.exit(result.exitCode);
}

const invokedDirectly = (() => {
	try {
		const argv1 = process.argv[1];
		if (!argv1) return false;
		const normArg = argv1.replace(/\\/g, "/").toLowerCase();
		const normUrl = import.meta.url
			.replace(/^file:\/\/\//, "")
			.replace(/\\/g, "/")
			.toLowerCase();
		return normUrl.endsWith(normArg.replace(/^.*[\\/]/, ""));
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	main().catch((err) => {
		const detail =
			err instanceof Error ? (err.stack ?? err.message) : String(err);
		process.stderr.write(`error: ${detail}\n`);
		process.exit(1);
	});
}
