import { spawn } from "node:child_process";
import {
	type AuthProfile,
	AuthResolveError,
	type CallContext,
	type CredentialProvider,
	type ResolvedAuth,
} from "../types.js";

type ExecScriptProfile = Extract<AuthProfile, { type: "exec-script" }>;

export interface ExecInvokeMeta {
	profileName: string;
	command: string;
	exitCode: number;
	durationMs: number;
	timedOut: boolean;
}

export type ExecInvokeListener = (meta: ExecInvokeMeta) => void;

export interface ExecScriptProviderOptions {
	profileName?: string;
	now?: () => number;
	/**
	 * Called after every subprocess invocation with command name, exit code,
	 * and duration. Used by the CLI to forward to `src/audit/logger.ts`. Never
	 * includes stdout, stderr, env, or args — only the head of the command.
	 */
	onInvoke?: ExecInvokeListener;
	/**
	 * Inject a `spawn`-like fn for tests. Defaults to `node:child_process.spawn`.
	 */
	spawnImpl?: typeof spawn;
}

interface CachedExec {
	resolved: ResolvedAuth;
	expiresAt: number;
}

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	durationMs: number;
}

interface JsonOutput {
	headers?: Record<string, string>;
	expiresInSeconds?: number;
}

export function createExecScriptProvider(
	profile: ExecScriptProfile,
	opts: ExecScriptProviderOptions = {},
): CredentialProvider {
	const now = opts.now ?? Date.now;
	const profileName = opts.profileName ?? "exec-script";
	const spawnImpl = opts.spawnImpl ?? spawn;

	let cached: CachedExec | null = null;
	let inFlight: Promise<CachedExec> | null = null;

	async function invoke(): Promise<CachedExec> {
		const t0 = now();
		const result = await runOnce(profile, spawnImpl);
		const durationMs = result.durationMs;
		opts.onInvoke?.({
			profileName,
			command: profile.command[0],
			exitCode: result.exitCode,
			durationMs,
			timedOut: result.timedOut,
		});

		if (result.timedOut) {
			throw new AuthResolveError(
				`exec-script '${profile.command[0]}' timed out after ${profile.timeoutMs}ms`,
				profileName,
			);
		}
		if (result.exitCode !== 0) {
			throw new AuthResolveError(
				`exec-script '${profile.command[0]}' exited ${result.exitCode}: ${truncate(result.stderr, 200)}`,
				profileName,
			);
		}

		let headers: Record<string, string>;
		let ttlSeconds = profile.cacheTtlSeconds;

		if (profile.parseOutputAs === "json") {
			let parsed: JsonOutput;
			try {
				parsed = JSON.parse(result.stdout) as JsonOutput;
			} catch (cause) {
				throw new AuthResolveError(
					`exec-script '${profile.command[0]}' stdout is not valid JSON`,
					profileName,
					cause,
				);
			}
			if (!parsed.headers || typeof parsed.headers !== "object") {
				throw new AuthResolveError(
					`exec-script '${profile.command[0]}' JSON output missing headers`,
					profileName,
				);
			}
			headers = { ...parsed.headers };
			if (
				typeof parsed.expiresInSeconds === "number" &&
				parsed.expiresInSeconds > 0
			) {
				ttlSeconds = parsed.expiresInSeconds;
			}
		} else {
			const output = result.stdout.trim();
			if (!profile.headerTemplate) {
				throw new AuthResolveError(
					`exec-script '${profileName}' parseOutputAs=raw requires headerTemplate`,
					profileName,
				);
			}
			headers = {};
			for (const [k, tmpl] of Object.entries(profile.headerTemplate)) {
				headers[k] = tmpl.split("{output}").join(output);
			}
		}

		return {
			resolved: { headers },
			expiresAt: now() + ttlSeconds * 1000,
		};
	}

	return {
		type: "exec-script",
		async resolve(_ctx: CallContext): Promise<ResolvedAuth> {
			if (cached && now() < cached.expiresAt) {
				return { headers: { ...cached.resolved.headers } };
			}
			if (!inFlight) {
				inFlight = (async () => {
					try {
						const next = await invoke();
						cached = next;
						return next;
					} catch (err) {
						cached = null;
						throw err;
					} finally {
						inFlight = null;
					}
				})();
			}
			const next = await inFlight;
			return { headers: { ...next.resolved.headers } };
		},
	};
}

function runOnce(
	profile: ExecScriptProfile,
	spawnImpl: typeof spawn,
): Promise<ExecResult> {
	return new Promise<ExecResult>((resolve) => {
		const [command, ...args] = profile.command;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, profile.timeoutMs);

		const t0 = performance.now();
		const child = spawnImpl(command, args, {
			shell: false,
			env: profile.env
				? { ...process.env, ...profile.env }
				: { ...process.env },
			cwd: profile.cwd,
			signal: controller.signal,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
		child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

		child.once("error", (err) => {
			clearTimeout(timer);
			const durationMs = Math.round(performance.now() - t0);
			resolve({
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: (err as Error).message,
				exitCode: -1,
				timedOut,
				durationMs,
			});
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			const durationMs = Math.round(performance.now() - t0);
			resolve({
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
				exitCode: code ?? -1,
				timedOut,
				durationMs,
			});
		});
	});
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}
