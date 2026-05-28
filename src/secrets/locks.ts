import { resolve as resolvePath } from "node:path";

/**
 * Per-store write serialisation.
 *
 * Why this exists: `setSecret` (libsodium) and `setFallbackSecret` (node:crypto)
 * end with `appendFile(storePath, line)`. On Windows NTFS, `fs/promises.appendFile`
 * is NOT atomic across parallel awaits — concurrent calls can race on the file
 * pointer and either interleave bytes or drop a write. The symptom seen in CI
 * (TASK-976) was 9 lines in a file where 8 were expected.
 *
 * Fix: chain writes for the same store through a per-path Promise queue. Each
 * call awaits its predecessor before running, so the critical section (read
 * header → derive key → append entry) executes sequentially per `storePath`.
 *
 * In-process scope: this lock is per Node.js process. Two terminals running
 * `choda-gateway secrets set` in parallel would still race; that needs a
 * filesystem lock (flock / `proper-lockfile`) and is out of scope here — the
 * test flake we are fixing is single-process parallel writes.
 *
 * Failures do not break the chain: a rejected task lets the next caller run
 * its own task fresh.
 */

const writeLocks = new Map<string, Promise<unknown>>();

export function withStoreWriteLock<T>(
	storePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = resolvePath(storePath);
	const previous = writeLocks.get(key) ?? Promise.resolve();
	// `.then(fn, fn)` runs fn whether previous resolved or rejected — we don't
	// want one caller's failure to skip the next caller's work.
	const next = previous.then(fn, fn);
	// Park a swallowed copy so the next chain link doesn't see the rejection.
	writeLocks.set(
		key,
		next.catch(() => undefined),
	);
	return next;
}
