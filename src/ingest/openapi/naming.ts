const TOOL_NAME_PATTERN =
	/^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?__[a-z0-9][a-z0-9_]{0,62}[a-z0-9]$/;
const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/;

/**
 * Derive the per-operation `action` suffix for `<group>__<action>` when the
 * spec does not provide `operationId`. Pattern: lowercased verb, then the
 * path with `/{}` collapsed to underscores and runs of non-`[a-z0-9_]`
 * trimmed.
 *
 * Example:
 *   GET /pets/{petId}/orders  →  get_pets_petid_orders
 */
export function deriveActionFromVerbPath(verb: string, path: string): string {
	const v = verb.toLowerCase();
	const p = path
		.toLowerCase()
		.replace(/[/{}]/g, "_")
		.replace(/[^a-z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
	const action = p ? `${v}_${p}` : v;
	return clipAction(action);
}

/**
 * Normalise an `operationId` to the `<action>` slot of `<group>__<action>`:
 * lowercase, camelCase → snake_case, non-`[a-z0-9_]` → `_`, collapse runs.
 */
export function normaliseOperationId(operationId: string): string {
	const lowered = operationId
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
	return clipAction(lowered.length > 0 ? lowered : "op");
}

function clipAction(action: string): string {
	// ADR-005 action slot is `[a-z0-9][a-z0-9_]{0,62}[a-z0-9]` — minimum 2 chars,
	// max 64. First + last must be alphanumeric.
	if (action.length === 0) return "op";
	let out = action.slice(0, 64);
	out = out.replace(/_+$/, ""); // trailing underscores would fail the last-char check
	if (out.length === 0) return "op";
	if (out.length === 1) {
		// Single-char names like "a" fail the pattern; pad to keep deterministic.
		return `${out}_op`;
	}
	return out;
}

export function buildToolName(group: string, action: string): string {
	return `${group}__${action}`;
}

export function isValidToolName(name: string): boolean {
	return TOOL_NAME_PATTERN.test(name);
}

export function isValidNamespace(group: string): boolean {
	return NAMESPACE_PATTERN.test(group);
}
