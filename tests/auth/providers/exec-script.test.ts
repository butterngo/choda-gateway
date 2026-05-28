import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	type ExecInvokeMeta,
	createExecScriptProvider,
} from "../../../src/auth/providers/exec-script.js";
import { AuthResolveError } from "../../../src/auth/types.js";

interface FakeChildOptions {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	delayMs?: number;
	emitError?: Error;
}

function makeFakeChild(opts: FakeChildOptions) {
	const child = new EventEmitter() as EventEmitter & {
		stdout: Readable | null;
		stderr: Readable | null;
	};
	child.stdout = Readable.from([Buffer.from(opts.stdout ?? "", "utf8")]);
	child.stderr = Readable.from([Buffer.from(opts.stderr ?? "", "utf8")]);
	setTimeout(() => {
		if (opts.emitError) {
			child.emit("error", opts.emitError);
			return;
		}
		child.emit("close", opts.exitCode ?? 0, null);
	}, opts.delayMs ?? 0);
	return child;
}

function fakeSpawn(opts: FakeChildOptions) {
	// biome-ignore lint/suspicious/noExplicitAny: spawn return type fakery
	return vi.fn(() => makeFakeChild(opts) as any);
}

const BASE = {
	type: "exec-script" as const,
	command: ["gcloud", "auth", "print-access-token"],
	cacheTtlSeconds: 60,
	timeoutMs: 5_000,
	parseOutputAs: "raw" as const,
	headerTemplate: { Authorization: "Bearer {output}" },
};

describe("exec-script provider — raw output + headerTemplate", () => {
	it("substitutes {output} into the template (trimmed)", async () => {
		const provider = createExecScriptProvider(BASE, {
			spawnImpl: fakeSpawn({ stdout: "  ya29.abc123\n" }),
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth).toEqual({ headers: { Authorization: "Bearer ya29.abc123" } });
	});

	it("raw without headerTemplate throws", async () => {
		const provider = createExecScriptProvider(
			{ ...BASE, headerTemplate: undefined },
			{ spawnImpl: fakeSpawn({ stdout: "tok" }) },
		);
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			/parseOutputAs=raw requires headerTemplate/,
		);
	});
});

describe("exec-script provider — json output", () => {
	const JSON_PROFILE = {
		...BASE,
		parseOutputAs: "json" as const,
		headerTemplate: undefined,
	};

	it("parses {headers} from JSON stdout", async () => {
		const provider = createExecScriptProvider(JSON_PROFILE, {
			spawnImpl: fakeSpawn({
				stdout: JSON.stringify({
					headers: { Authorization: "Bearer x", "X-Auth-By": "script" },
				}),
			}),
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers).toEqual({
			Authorization: "Bearer x",
			"X-Auth-By": "script",
		});
	});

	it("expiresInSeconds overrides cacheTtlSeconds", async () => {
		let nowMs = 1_000_000;
		const spawnImpl = fakeSpawn({
			stdout: JSON.stringify({
				headers: { A: "1" },
				expiresInSeconds: 10,
			}),
		});
		const provider = createExecScriptProvider(
			{ ...JSON_PROFILE, cacheTtlSeconds: 9999 },
			{ now: () => nowMs, spawnImpl },
		);
		await provider.resolve({ toolName: "t" });
		nowMs += 5_000;
		await provider.resolve({ toolName: "t" });
		expect(spawnImpl).toHaveBeenCalledTimes(1);
		nowMs += 10_000;
		await provider.resolve({ toolName: "t" });
		expect(spawnImpl).toHaveBeenCalledTimes(2);
	});

	it("non-JSON stdout in json mode -> AuthResolveError", async () => {
		const provider = createExecScriptProvider(JSON_PROFILE, {
			spawnImpl: fakeSpawn({ stdout: "<html>" }),
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			/not valid JSON/,
		);
	});

	it("json without headers -> AuthResolveError", async () => {
		const provider = createExecScriptProvider(JSON_PROFILE, {
			spawnImpl: fakeSpawn({ stdout: JSON.stringify({ token: "x" }) }),
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			/missing headers/,
		);
	});
});

describe("exec-script provider — errors", () => {
	it("non-zero exit -> AuthResolveError with exit code + stderr head", async () => {
		const provider = createExecScriptProvider(BASE, {
			spawnImpl: fakeSpawn({
				exitCode: 2,
				stderr: "ERROR: gcloud not logged in",
			}),
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			/exited 2/,
		);
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			/gcloud not logged in/,
		);
	});

	it("spawn error -> AuthResolveError (no fall-through to ok)", async () => {
		const provider = createExecScriptProvider(BASE, {
			spawnImpl: fakeSpawn({ emitError: new Error("ENOENT: gcloud") }),
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow(
			AuthResolveError,
		);
	});
});

describe("exec-script provider — cache + concurrency", () => {
	it("second resolve() within TTL does NOT spawn again", async () => {
		let nowMs = 1_000_000;
		const spawnImpl = fakeSpawn({ stdout: "tok" });
		const provider = createExecScriptProvider(BASE, {
			now: () => nowMs,
			spawnImpl,
		});
		await provider.resolve({ toolName: "t" });
		nowMs += 5_000;
		await provider.resolve({ toolName: "t" });
		expect(spawnImpl).toHaveBeenCalledTimes(1);
	});

	it("concurrent resolve() calls share the in-flight invocation", async () => {
		const spawnImpl = vi.fn(
			() =>
				// biome-ignore lint/suspicious/noExplicitAny: spawn return type fakery
				makeFakeChild({ stdout: "tok", delayMs: 30 }) as any,
		);
		const provider = createExecScriptProvider(BASE, { spawnImpl });
		const [a, b, c] = await Promise.all([
			provider.resolve({ toolName: "t" }),
			provider.resolve({ toolName: "t" }),
			provider.resolve({ toolName: "t" }),
		]);
		expect(spawnImpl).toHaveBeenCalledTimes(1);
		expect(a.headers.Authorization).toBe("Bearer tok");
		expect(b.headers.Authorization).toBe("Bearer tok");
		expect(c.headers.Authorization).toBe("Bearer tok");
	});

	it("after a failed invoke the cache is cleared (next resolve retries)", async () => {
		let call = 0;
		const spawnImpl = vi.fn(() => {
			call++;
			if (call === 1) {
				// biome-ignore lint/suspicious/noExplicitAny: spawn return type fakery
				return makeFakeChild({ exitCode: 1, stderr: "boom" }) as any;
			}
			// biome-ignore lint/suspicious/noExplicitAny: spawn return type fakery
			return makeFakeChild({ stdout: "tok-rec" }) as any;
		});
		const provider = createExecScriptProvider(BASE, { spawnImpl });
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow();
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers.Authorization).toBe("Bearer tok-rec");
	});
});

describe("exec-script provider — audit hook", () => {
	it("onInvoke fires with command head + exit code + duration, no stdout/stderr", async () => {
		const events: ExecInvokeMeta[] = [];
		const provider = createExecScriptProvider(BASE, {
			profileName: "gcloud-ops",
			spawnImpl: fakeSpawn({ stdout: "tok", exitCode: 0 }),
			onInvoke: (m) => events.push(m),
		});
		await provider.resolve({ toolName: "t" });
		expect(events).toHaveLength(1);
		expect(events[0].profileName).toBe("gcloud-ops");
		expect(events[0].command).toBe("gcloud");
		expect(events[0].exitCode).toBe(0);
		expect(events[0].timedOut).toBe(false);
		expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
		// Sanity: no stdout/stderr leaked into the audit shape
		expect(events[0]).not.toHaveProperty("stdout");
		expect(events[0]).not.toHaveProperty("stderr");
	});

	it("onInvoke fires even on failure (exit code recorded)", async () => {
		const events: ExecInvokeMeta[] = [];
		const provider = createExecScriptProvider(BASE, {
			spawnImpl: fakeSpawn({ exitCode: 2, stderr: "bad" }),
			onInvoke: (m) => events.push(m),
		});
		await expect(provider.resolve({ toolName: "t" })).rejects.toThrow();
		expect(events).toHaveLength(1);
		expect(events[0].exitCode).toBe(2);
	});
});

describe("exec-script provider — real subprocess smoke", () => {
	it("runs `node -e` and parses output via headerTemplate", async () => {
		const provider = createExecScriptProvider({
			...BASE,
			command: [process.execPath, "-e", "process.stdout.write('real-tok')"],
		});
		const auth = await provider.resolve({ toolName: "t" });
		expect(auth.headers.Authorization).toBe("Bearer real-tok");
	});
});
