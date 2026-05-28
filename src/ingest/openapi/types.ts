export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const SUPPORTED_METHODS: readonly HttpMethod[] = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
];

export interface ParsedSpecInfo {
	title: string;
	version: string;
	description?: string;
	openapiVersion: string;
	defaultBaseUrl?: string;
}

export interface ParsedParameter {
	name: string;
	in: "path" | "query" | "header";
	required: boolean;
	description?: string;
	schema?: Record<string, unknown>;
}

export interface ParsedRequestBody {
	required: boolean;
	schema: Record<string, unknown>;
}

export interface ParsedOperation {
	method: HttpMethod;
	path: string;
	operationId?: string;
	summary?: string;
	description?: string;
	tags: string[];
	parameters: ParsedParameter[];
	requestBody?: ParsedRequestBody;
	responses: Record<string, Record<string, unknown>>;
	securitySchemes?: Record<string, Record<string, unknown>>;
	/** Top-level operation node — used to surface x-choda-* extensions. */
	rawNode: Record<string, unknown>;
}

export interface ParsedSpec {
	info: ParsedSpecInfo;
	operations: ParsedOperation[];
	warnings: string[];
}

export class OpenApiParseError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "OpenApiParseError";
	}
}
