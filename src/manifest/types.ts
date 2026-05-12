import type { z } from "zod";
import type {
	GatewayConfigSchema,
	ToolSchema,
	ToolsManifestSchema,
} from "./schema.js";

export type Tool = z.infer<typeof ToolSchema>;
export type ToolsManifest = z.infer<typeof ToolsManifestSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type UpstreamType = Tool["upstream"]["type"];
