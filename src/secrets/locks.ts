import { resolve as resolvePath } from "node:path";

/**
 * Per-store write serialisation.
 *
 * Why this exists: parallel `setSecret` (libsodium) or `setFallbackSecret`
 * (node:crypto) calls on the same store would race on the final write to
 * disk. On Windows NTFS, `fs.appendFile` was observed to lose or duplicate
 * lines under contention (TASK-976). Even `readFile + writeFile` is not safe
 * without serialisation — concurrent callers would each read the same
 * pre-state and last writer wins.
 *
 * Fix: a per-store async mutex. Each call waits for its predecessor before
 * running, so the critical section (read header → derive key → read existing
 * bytes → writeFile) executes sequentially per `storePath`.
 *
 * In-process scope: this lock is per Node.js process. Cross-process
 * coordination (two terminals running `choda-gateway secrets set` in
 * parallel) would need a filesystem lock (`flock` / `proper-lockfile`) and
 * is out of scope here — we are fixing the test flake from single-process
 * parallel writes.
 */

class AsyncMutex {
	private locked = false;
	private waiters: Array<() => void> = [];

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (!this.locked) {
			this.locked = true;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) {
			// Hand off the lock atomically — `locked` stays true so a new caller
			// can't squeeze in between release() and the awakened next runner.
			next();
		} else {
			this.locked = false;
		}
	}
}

const mutexes = new Map<string, AsyncMutex>();

export function withStoreWriteLock<T>(
	storePath: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = resolvePath(storePath);
	let m = mutexes.get(key);
	if (!m) {
		m = new AsyncMutex();
		mutexes.set(key, m);
	}
	return m.run(fn);
}
