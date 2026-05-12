export type UpstreamType = "mcp" | "rest" | "cli";

interface BaseEntry {
	corrId: string;
	ts: string;
	toolName: string;
	profile: string;
}

export interface RequestReceivedEntry extends BaseEntry {
	event: "request.received";
	input: unknown;
	secretRefs: string[];
}

export interface UpstreamDispatchedEntry extends BaseEntry {
	event: "upstream.dispatched";
	upstreamType: UpstreamType;
	upstreamId: string;
	attempt: number;
}

export interface UpstreamCompletedEntry extends BaseEntry {
	event: "upstream.completed";
	upstreamType: UpstreamType;
	durationMs: number;
	ok: boolean;
	errKind?: string;
}

export interface ResponseReturnedEntry extends BaseEntry {
	event: "response.returned";
	durationMs: number;
	ok: boolean;
	errKind?: string;
}

export type AuditEntry =
	| RequestReceivedEntry
	| UpstreamDispatchedEntry
	| UpstreamCompletedEntry
	| ResponseReturnedEntry;
