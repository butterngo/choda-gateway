const REDACTED = "***";

export interface MaskOptions {
	values: Iterable<string>;
}

/**
 * Replace every occurrence of any masked value in `input` with "***".
 * - Longest values match first to avoid partial overlap.
 * - Empty / whitespace-only values are skipped (would match unbounded substrings).
 */
export function maskString(input: string, opts: MaskOptions): string {
	const sorted = [...opts.values]
		.filter((v) => v.length > 0 && v.trim().length > 0)
		.sort((a, b) => b.length - a.length);
	let out = input;
	for (const v of sorted) {
		if (!out.includes(v)) continue;
		out = out.split(v).join(REDACTED);
	}
	return out;
}

/**
 * Mask a JSON-serializable value by JSON-stringifying with a replacer that
 * scans strings for any of `values` and substitutes "***". The structure of
 * the object is preserved; only string leaves are mutated.
 */
export function maskJson(value: unknown, opts: MaskOptions): unknown {
	const values = [...opts.values].filter(
		(v) => v.length > 0 && v.trim().length > 0,
	);
	if (values.length === 0) return value;
	return walk(value, values);
}

function walk(value: unknown, values: string[]): unknown {
	if (typeof value === "string") {
		return maskString(value, { values });
	}
	if (Array.isArray(value)) return value.map((v) => walk(v, values));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = walk(v, values);
		}
		return out;
	}
	return value;
}
