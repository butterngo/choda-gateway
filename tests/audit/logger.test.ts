import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditLogger } from "../../src/audit/logger.js";
import type {
	RequestReceivedEntry,
	ResponseReturnedEntry,
	UpstreamCompletedEntry,
	UpstreamDispatchedEntry,
} from "../../src/audit/types.js";
import { generateCorrId } from "../../src/util/ids.js";

let dir: string;
let filepath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "audit-"));
	filepath = join(dir, "audit.jsonl");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function readLines(path: string): Promise<string[]> {
	const raw = await readFile(path, "utf8");
	return raw.split("\n").filter((line) => line.trim().length > 0);
}

describe("createAuditLogger", () => {
	it("writes one JSONL line per log() call and preserves event/corrId/profile/toolName", async () => {
		const corrId = generateCorrId();
		const logger = createAuditLogger({ filepath });

		const base = {
			corrId,
			ts: "2026-05-12T08:00:00.000Z",
			toolName: "linear__issue_search",
			profile: "coding",
		};

		const received: RequestReceivedEntry = {
			...base,
			event: "request.received",
			input: { query: "gateway" },
			secretRefs: ["LINEAR_API_KEY"],
		};
		const dispatched: UpstreamDispatchedEntry = {
			...base,
			event: "upstream.dispatched",
			upstreamType: "rest",
			upstreamId: "POST https://api.linear.app/graphql",
			attempt: 1,
		};
		const completed: UpstreamCompletedEntry = {
			...base,
			event: "upstream.completed",
			upstreamType: "rest",
			durationMs: 185,
			ok: true,
		};
		const returned: ResponseReturnedEntry = {
			...base,
			event: "response.returned",
			durationMs: 189,
			ok: true,
		};

		await logger.log(received);
		await logger.log(dispatched);
		await logger.log(completed);
		await logger.log(returned);

		const lines = await readLines(filepath);
		expect(lines).toHaveLength(4);

		const events = lines.map((l) => JSON.parse(l).event);
		expect(events).toEqual([
			"request.received",
			"upstream.dispatched",
			"upstream.completed",
			"response.returned",
		]);

		const corrIds = lines.map((l) => JSON.parse(l).corrId);
		expect(new Set(corrIds).size).toBe(1);
		expect(corrIds[0]).toBe(corrId);
	});

	it("auto-masks secret values from the SecretStore everywhere in the entry", async () => {
		const logger = createAuditLogger({
			filepath,
			secretStore: {
				maskedValues: () => ["lin_abc123"],
			},
		});

		const dispatched: UpstreamDispatchedEntry = {
			corrId: "corr_01HV2TPQ7XJZB9C0XMRYK4N8FA",
			ts: "2026-05-12T08:00:00.000Z",
			toolName: "linear__issue_search",
			profile: "coding",
			event: "upstream.dispatched",
			upstreamType: "rest",
			upstreamId: "POST https://api.linear.app/graphql with Bearer lin_abc123",
			attempt: 1,
		};

		await logger.log(dispatched);
		const raw = await readFile(filepath, "utf8");
		expect(raw.includes("lin_abc123")).toBe(false);
		expect(raw.includes("***")).toBe(true);
	});

	it("preserves secretRefs (names) untouched even when their values are masked", async () => {
		const logger = createAuditLogger({
			filepath,
			secretStore: { maskedValues: () => ["lin_abc123"] },
		});

		const received: RequestReceivedEntry = {
			corrId: "corr_01HV2TPQ7XJZB9C0XMRYK4N8FA",
			ts: "2026-05-12T08:00:00.000Z",
			toolName: "linear__issue_search",
			profile: "coding",
			event: "request.received",
			input: { token: "lin_abc123" },
			secretRefs: ["LINEAR_API_KEY"],
		};

		await logger.log(received);
		const parsed = JSON.parse((await readFile(filepath, "utf8")).trim());
		expect(parsed.secretRefs).toEqual(["LINEAR_API_KEY"]);
		expect(parsed.input.token).toBe("***");
	});

	it("appends — does not overwrite — across concurrent log() calls", async () => {
		const logger = createAuditLogger({ filepath });
		const base = {
			ts: "2026-05-12T08:00:00.000Z",
			toolName: "x__y",
			profile: "all",
		};
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				logger.log({
					...base,
					corrId: `corr_01HV2TPQ7XJZB9C0XMRYK4N8F${String.fromCharCode(65 + i)}`,
					event: "response.returned",
					durationMs: i,
					ok: true,
				}),
			),
		);

		const lines = await readLines(filepath);
		expect(lines).toHaveLength(8);
		for (const line of lines) {
			const parsed = JSON.parse(line);
			expect(parsed.event).toBe("response.returned");
		}
	});
});
