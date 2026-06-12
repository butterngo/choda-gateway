// Method B helper: turn a Playwright storageState dump into the cookie-jar file.
// Reads _playwright-storage-state.json, picks the test-api.ichiba.net cookies,
// writes them as one inline data line into ichiba_cookies.txt (preserving the
// comment header), then deletes the temp storage-state file.
// Prints cookie NAMES only — never values.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DIR = "C:/dev/choda-gateway/sensitive_information";
const STATE = `${DIR}/_playwright-storage-state.json`;
const OUT = `${DIR}/ichiba_cookies.txt`;
const DOMAIN = "test-api.ichiba.net";
const WANT = ["SERVERID", "__BFF"]; // order matters for readability

if (!existsSync(STATE)) {
	console.error(`storage-state not found: ${STATE}`);
	process.exit(1);
}

const state = JSON.parse(readFileSync(STATE, "utf8"));
const onDomain = (state.cookies ?? []).filter(
	(c) => c.domain === DOMAIN || c.domain === `.${DOMAIN}`,
);

const picked = [];
for (const name of WANT) {
	const c = onDomain.find((x) => x.name === name);
	if (c) picked.push(c);
}

if (!picked.some((c) => c.name === "__BFF")) {
	console.error(`ERROR: __BFF cookie not found for ${DOMAIN} — login may have failed`);
	process.exit(1);
}

const dataLine = picked.map((c) => `${c.name}=${c.value}`).join("; ");

// Preserve comment/blank lines from the existing file; drop any old data line.
let comments = [];
if (existsSync(OUT)) {
	comments = readFileSync(OUT, "utf8")
		.split(/\r?\n/)
		.filter((l) => l.trim() === "" || l.trimStart().startsWith("#"));
}
while (comments.length && comments[comments.length - 1].trim() === "") comments.pop();

writeFileSync(OUT, `${comments.join("\n")}\n${dataLine}\n`, "utf8");
rmSync(STATE, { force: true });

console.log(
	JSON.stringify(
		{
			wrote: OUT,
			cookieNames: picked.map((c) => c.name), // names only, no values
			bffLength: picked.find((c) => c.name === "__BFF").value.length,
			tempDeleted: !existsSync(STATE),
		},
		null,
		2,
	),
);
