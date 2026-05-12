#!/usr/bin/env node
// Verify an audit.jsonl file produced by choda-gateway.
//
// Usage:
//   node scripts/verify-smoke-audit.mjs <audit.jsonl>               # validate every line + summarise corrIds
//   node scripts/verify-smoke-audit.mjs <audit.jsonl> <corrId>      # assert exactly 4 ordered events for corrId
//
// Exit codes: 0 = pass; 1 = at least one assertion failed; 2 = bad CLI usage.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_ORDER = [
	"request.received",
	"upstream.dispatched",
	"upstream.completed",
	"response.returned",
];

function usage() {
	process.stderr.write(
		[
			"Usage:",
			"  node scripts/verify-smoke-audit.mjs <audit.jsonl>",
			"  node scripts/verify-smoke-audit.mjs <audit.jsonl> <corrId>",
			"",
			"Validates each line against audit-entry.schema.json, summarises corrIds,",
			"and (if corrId given) asserts the 4-event lifecycle ordering.",
		].join("\n") + "\n",
	);
	process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) usage();
const auditPath = resolve(args[0]);
const filterCorrId = args[1] ?? null;

if (!existsSync(auditPath)) {
	process.stderr.write(`audit file not found: ${auditPath}\n`);
	process.exit(2);
}

const schemaPath = locateSchema();
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const validate = ajv.compile(schema);

const rawLines = readFileSync(auditPath, "utf8").split(/\r?\n/).filter(Boolean);
const entries = [];
let failures = 0;
rawLines.forEach((line, i) => {
	let obj;
	try {
		obj = JSON.parse(line);
	} catch (err) {
		failures++;
		console.error(`line ${i + 1}: invalid JSON — ${err.message}`);
		return;
	}
	if (!validate(obj)) {
		failures++;
		console.error(`line ${i + 1} (${obj.event ?? "?"}): schema invalid`);
		for (const e of validate.errors ?? []) {
			console.error(`  · ${e.instancePath || "<root>"} ${e.message}`);
		}
		return;
	}
	entries.push({ line: i + 1, ...obj });
});

if (failures > 0) {
	console.error(`\n✗ ${failures} schema violation(s) in ${rawLines.length} line(s)`);
	process.exit(1);
}

if (filterCorrId === null) {
	summariseCorrIds(entries);
	process.exit(0);
}

const lifecycle = entries.filter((e) => e.corrId === filterCorrId);
if (lifecycle.length === 0) {
	console.error(`✗ no entries found for corrId=${filterCorrId}`);
	process.exit(1);
}

let ok = true;

if (lifecycle.length !== 4) {
	console.error(
		`✗ expected 4 entries for ${filterCorrId}, got ${lifecycle.length}`,
	);
	ok = false;
}

for (let i = 0; i < Math.min(lifecycle.length, EXPECTED_ORDER.length); i++) {
	if (lifecycle[i].event !== EXPECTED_ORDER[i]) {
		console.error(
			`✗ position ${i + 1}: expected ${EXPECTED_ORDER[i]}, got ${lifecycle[i].event} (line ${lifecycle[i].line})`,
		);
		ok = false;
	}
}

const toolNames = new Set(lifecycle.map((e) => e.toolName));
if (toolNames.size > 1) {
	console.error(`✗ corrId ${filterCorrId} spans multiple toolNames: ${[...toolNames].join(", ")}`);
	ok = false;
}

const profiles = new Set(lifecycle.map((e) => e.profile));
if (profiles.size > 1) {
	console.error(`✗ corrId ${filterCorrId} spans multiple profiles: ${[...profiles].join(", ")}`);
	ok = false;
}

if (ok) {
	const dispatched = lifecycle.find((e) => e.event === "upstream.dispatched");
	const completed = lifecycle.find((e) => e.event === "upstream.completed");
	const returned = lifecycle.find((e) => e.event === "response.returned");
	console.log(`✓ corrId=${filterCorrId} 4 events ordered correctly`);
	console.log(`  tool=${[...toolNames][0]} profile=${[...profiles][0]}`);
	if (dispatched) {
		console.log(
			`  upstream: type=${dispatched.upstreamType} id=${dispatched.upstreamId} attempt=${dispatched.attempt}`,
		);
	}
	if (completed) {
		console.log(
			`  upstream.durationMs=${completed.durationMs} ok=${completed.ok}${completed.errKind ? ` errKind=${completed.errKind}` : ""}`,
		);
	}
	if (returned) {
		console.log(
			`  total.durationMs=${returned.durationMs} ok=${returned.ok}${returned.errKind ? ` errKind=${returned.errKind}` : ""}`,
		);
	}
}

process.exit(ok ? 0 : 1);

function summariseCorrIds(entries) {
	const byCorr = new Map();
	for (const e of entries) {
		const cur = byCorr.get(e.corrId) ?? {
			events: [],
			tool: e.toolName,
			profile: e.profile,
			latencyMs: null,
			ok: null,
			errKind: null,
		};
		cur.events.push(e.event);
		if (e.event === "response.returned") {
			cur.latencyMs = e.durationMs;
			cur.ok = e.ok;
			cur.errKind = e.errKind ?? null;
		}
		byCorr.set(e.corrId, cur);
	}
	const rows = [];
	let okCount = 0;
	let errCount = 0;
	let incomplete = 0;
	const latencies = { mcp: [], rest: [], cli: [], other: [] };
	for (const e of entries) {
		const cur = byCorr.get(e.corrId);
		if (e.event === "upstream.completed") {
			const bucket = latencies[e.upstreamType] ?? latencies.other;
			bucket.push(e.durationMs);
			cur.upstreamType = e.upstreamType;
		}
	}
	for (const [corrId, info] of byCorr) {
		const complete = info.events.length === 4;
		if (!complete) incomplete++;
		else if (info.ok) okCount++;
		else errCount++;
		rows.push({
			corrId,
			tool: info.tool,
			profile: info.profile,
			events: info.events.length,
			ok: info.ok,
			latencyMs: info.latencyMs,
			errKind: info.errKind,
			upstreamType: info.upstreamType ?? "?",
		});
	}
	rows.sort((a, b) =>
		(a.tool ?? "").localeCompare(b.tool ?? "") ||
		(a.corrId ?? "").localeCompare(b.corrId ?? ""),
	);
	console.log(`✓ ${entries.length} entries validated against schema`);
	console.log(`  ${byCorr.size} unique corrId(s): ok=${okCount} err=${errCount} incomplete=${incomplete}`);
	for (const r of rows) {
		const status = r.events !== 4 ? `INCOMPLETE(${r.events}/4)` : r.ok ? "ok" : `err(${r.errKind ?? "?"})`;
		console.log(
			`  - ${r.corrId} ${r.upstreamType} ${r.tool}@${r.profile} ${status} ${r.latencyMs ?? "?"}ms`,
		);
	}
	console.log("\nupstream.completed latency by type:");
	for (const [type, arr] of Object.entries(latencies)) {
		if (arr.length === 0) continue;
		arr.sort((a, b) => a - b);
		const p50 = arr[Math.floor(arr.length * 0.5)] ?? 0;
		const p95 = arr[Math.floor(arr.length * 0.95)] ?? arr[arr.length - 1];
		console.log(
			`  ${type}: n=${arr.length} p50=${p50}ms p95=${p95}ms max=${arr[arr.length - 1]}ms`,
		);
	}
}

function locateSchema() {
	const candidates = [
		resolve(process.cwd(), "audit-entry.schema.json"),
		resolve(process.cwd(), "../audit-entry.schema.json"),
		resolve(import.meta.url.replace(/^file:\/\/\//, "").replace(/\\/g, "/"), "../../audit-entry.schema.json"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	process.stderr.write(
		`could not find audit-entry.schema.json (looked in ${candidates.join(", ")})\n`,
	);
	process.exit(2);
}
