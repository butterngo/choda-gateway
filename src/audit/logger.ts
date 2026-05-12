import { appendFile } from "node:fs/promises";
import type { SecretStore } from "../secrets/store.js";
import { maskJson } from "../util/mask.js";
import type { AuditEntry } from "./types.js";

export interface CreateAuditLoggerOptions {
	filepath: string;
	/**
	 * SecretStore whose loaded plaintexts will be masked out of every log line.
	 * Pass `undefined` to disable masking (e.g. integration tests with no real secrets).
	 */
	secretStore?: Pick<SecretStore, "maskedValues">;
}

export interface AuditLogger {
	log(entry: AuditEntry): Promise<void>;
}

/**
 * Append-only JSONL audit writer. Each `log()` call resolves once the line
 * has been flushed. Auto-masks substrings matching any value the SecretStore
 * has loaded; called after every get() so lazy-loaded values are covered too.
 *
 * Pino is intentionally not used here: vitest's worker model makes pino's
 * async transports flaky for unit tests, and the audit volume in this gateway
 * is low enough that plain `fs/promises.appendFile` is the right tool. A
 * pino destination can swap in later without changing the public API.
 */
export function createAuditLogger(opts: CreateAuditLoggerOptions): AuditLogger {
	return {
		async log(entry: AuditEntry): Promise<void> {
			const values = opts.secretStore?.maskedValues() ?? [];
			const masked = maskJson(entry, { values });
			const line = `${JSON.stringify(masked)}\n`;
			await appendFile(opts.filepath, line);
		},
	};
}
