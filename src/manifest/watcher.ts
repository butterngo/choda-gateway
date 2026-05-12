import { EventEmitter } from "node:events";
import { loadGatewayConfig, loadToolsManifest } from "./loader.js";
import type { GatewayConfig, ToolsManifest } from "./types.js";

export interface ManifestReloadPayload {
	manifest: ToolsManifest;
	config: GatewayConfig;
	configDir: string;
	resolvedToolsPath: string;
	resolvedAuditPath: string;
}

export interface ManifestWatcher extends EventEmitter {
	on(event: "reload", listener: (payload: ManifestReloadPayload) => void): this;
	on(event: "error", listener: (err: Error) => void): this;
	emit(event: "reload", payload: ManifestReloadPayload): boolean;
	emit(event: "error", err: Error): boolean;
}

export interface CreateManifestWatcherOptions {
	configPath: string;
	signal?: NodeJS.Signals; // default SIGHUP; on Windows SIGHUP is not deliverable, caller may pass undefined to skip signal binding
}

export function createManifestWatcher(opts: CreateManifestWatcherOptions): {
	watcher: ManifestWatcher;
	reload: () => Promise<void>;
	dispose: () => void;
} {
	const emitter = new EventEmitter() as ManifestWatcher;
	const signal = opts.signal === undefined ? "SIGHUP" : opts.signal;

	const reload = async (): Promise<void> => {
		try {
			const cfg = await loadGatewayConfig(opts.configPath);
			const manifest = await loadToolsManifest(cfg.resolvedToolsPath);
			emitter.emit("reload", {
				manifest,
				config: cfg.config,
				configDir: cfg.configDir,
				resolvedToolsPath: cfg.resolvedToolsPath,
				resolvedAuditPath: cfg.resolvedAuditPath,
			});
		} catch (err) {
			emitter.emit("error", err as Error);
		}
	};

	let bound = false;
	const handler = (): void => {
		void reload();
	};
	if (signal && process.platform !== "win32") {
		// Node on Windows does not deliver SIGHUP — bind only on POSIX. On Windows the
		// caller can drive `reload()` manually (CLI command, file watcher, etc.).
		process.on(signal, handler);
		bound = true;
	}

	const dispose = (): void => {
		if (bound && signal) {
			process.off(signal, handler);
			bound = false;
		}
	};

	return { watcher: emitter, reload, dispose };
}
