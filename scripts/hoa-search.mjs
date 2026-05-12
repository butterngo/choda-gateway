#!/usr/bin/env node
// hoa-search.mjs — wrap Mantu HoA navigation/search with az CLI delegated token.
// See vault/30-Knowledge/mantu-erp-azure-cli-delegated-token.md for why scope=api://erpapi/UseErp works for arp.mantu.com.

import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

function requireEnv(name) {
	const v = process.env[name];
	if (!v) {
		process.stderr.write(`error: env ${name} required\n`);
		process.exit(1);
	}
	return v;
}

const TENANT = requireEnv("MANTU_TENANT_ID");
const SCOPE = requireEnv("MANTU_API_SCOPE");
const BASE = requireEnv("MANTU_HOA_BASE_URL");

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		searchText: { type: "string" },
		searchType: { type: "string", default: "All" },
		page: { type: "string", default: "1" },
		rowsPerPage: { type: "string", default: "5" },
	},
	strict: true,
});

if (!values.searchText) {
	process.stderr.write("error: --searchText required\n");
	process.exit(1);
}

async function getToken() {
	// Windows needs shell:true to resolve az.cmd off PATH. The DEP0190 warning is
	// emitted to stderr by Node 22+; values are passed as an array (parseArgs-safe),
	// so the unescaped-shell-args risk does not apply here.
	const { stdout } = await execFileP(
		"az",
		["account", "get-access-token", "--tenant", TENANT, "--scope", SCOPE, "-o", "json"],
		{ shell: true, maxBuffer: 1024 * 1024 },
	);
	return JSON.parse(stdout).accessToken;
}

async function main() {
	const token = await getToken();
	const qs = new URLSearchParams({
		searchText: values.searchText,
		searchType: values.searchType,
		page: values.page,
		rowsPerPage: values.rowsPerPage,
	}).toString();
	const url = `${BASE}?${qs}`;
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	const text = await res.text();
	if (!res.ok) {
		process.stderr.write(`HTTP ${res.status} ${res.statusText}\n${text}\n`);
		process.exit(1);
	}
	process.stdout.write(text);
}

main().catch((err) => {
	process.stderr.write(`error: ${err.message ?? String(err)}\n`);
	process.exit(1);
});
