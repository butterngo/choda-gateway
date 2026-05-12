#!/usr/bin/env node
// timesheet-days-off.mjs — wrap Mantu timesheet days-off-summary with az CLI delegated token.
// See vault/30-Knowledge/mantu-erp-azure-cli-delegated-token.md for why scope=api://erpapi/UseErp works for arp.mantu.com.

import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TENANT = "ce57ebe3-a63d-4708-b5cf-c274b48bd26c";
const SCOPE = "api://erpapi/UseErp";
const BASE = "https://arp.mantu.com/timesheetV2-api/api/v1.0/calendar/days-off-summary";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		year: { type: "string" },
	},
	strict: true,
});

if (!values.year) {
	process.stderr.write("error: --year required\n");
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
	const qs = new URLSearchParams({ year: values.year }).toString();
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
