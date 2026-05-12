export class TemplateError extends Error {
	constructor(
		message: string,
		public readonly placeholderPath: string,
	) {
		super(message);
		this.name = "TemplateError";
	}
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/g;

export interface TemplateContext {
	input?: Record<string, unknown>;
	secrets?: Record<string, string>;
}

/**
 * Recursively resolve `{{input.path.to.field}}` and `{{secrets.NAME}}` placeholders.
 * Strings are scanned for placeholders; objects and arrays are walked structurally.
 * Unknown root namespaces and missing fields throw `TemplateError`.
 */
export function resolveTemplate<T>(value: T, ctx: TemplateContext): T {
	return resolve(value, ctx) as T;
}

function resolve(value: unknown, ctx: TemplateContext): unknown {
	if (typeof value === "string") return resolveString(value, ctx);
	if (Array.isArray(value)) return value.map((v) => resolve(v, ctx));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = resolve(v, ctx);
		}
		return out;
	}
	return value;
}

function resolveString(input: string, ctx: TemplateContext): string {
	return input.replace(PLACEHOLDER, (_match, expr: string) => {
		const [root, ...rest] = expr.split(".");
		if (root === "secrets") {
			if (rest.length !== 1) {
				throw new TemplateError(
					`secrets placeholder must be {{secrets.NAME}}: got '${expr}'`,
					expr,
				);
			}
			const name = rest[0];
			const value = ctx.secrets?.[name];
			if (value === undefined) {
				throw new TemplateError(`unknown secret: ${name}`, expr);
			}
			return value;
		}
		if (root === "input") {
			const value = lookupPath(ctx.input, rest);
			if (value === undefined) {
				throw new TemplateError(`missing input field: ${expr}`, expr);
			}
			return String(value);
		}
		throw new TemplateError(
			`unknown placeholder root '${root}' — expected input or secrets`,
			expr,
		);
	});
}

function lookupPath(
	obj: Record<string, unknown> | undefined,
	path: string[],
): unknown {
	let current: unknown = obj;
	for (const segment of path) {
		if (current === null || current === undefined) return undefined;
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}
