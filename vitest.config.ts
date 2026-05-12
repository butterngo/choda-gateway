import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			// Parallel-work worktrees live under .claude/worktrees/<task>; their tests should
			// not be picked up by the main repo's vitest run.
			".claude/worktrees/**",
		],
	},
});
