// Native messaging host for the ichiba cookie bridge extension.
//
// Chrome launches this process for each `sendNativeMessage` call, writes one
// length-prefixed JSON message to stdin, then expects one length-prefixed JSON
// reply on stdout. Protocol: a 32-bit little-endian byte length, then that many
// bytes of UTF-8 JSON. We read a single message, write the cookie-jar file, reply,
// and exit.
//
// Message in:  { "cookies": [ { "name": "SERVERID", "value": "…" }, { "name": "__BFF", "value": "…" } ] }
// Reply out:   { "ok": true, "wrote": "<path>", "names": ["SERVERID","__BFF"] }
//
// Never logs cookie values; the reply carries names only.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const COOKIE_FILE =
	process.env.ICHIBA_COOKIE_FILE ??
	"C:/dev/choda-gateway/sensitive_information/ichiba_cookies.txt";
const WANT = ["SERVERID", "__BFF"]; // written in this order

function writeCookieFile(cookies) {
	const map = new Map((cookies ?? []).map((c) => [c.name, c.value]));
	if (!map.has("__BFF")) throw new Error("payload has no __BFF cookie");
	const ordered = WANT.filter((n) => map.has(n));
	const dataLine = ordered.map((n) => `${n}=${map.get(n)}`).join("; ");

	// Preserve any comment/blank header lines; replace the single data line.
	let comments = [];
	if (existsSync(COOKIE_FILE)) {
		comments = readFileSync(COOKIE_FILE, "utf8")
			.split(/\r?\n/)
			.filter((l) => l.trim() === "" || l.trimStart().startsWith("#"));
	}
	while (comments.length && comments[comments.length - 1].trim() === "") {
		comments.pop();
	}
	const header = comments.length ? `${comments.join("\n")}\n` : "";
	writeFileSync(COOKIE_FILE, `${header}${dataLine}\n`, "utf8");
	return ordered;
}

function reply(msg, exitCode) {
	const json = Buffer.from(JSON.stringify(msg), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(json.length, 0);
	// Single write; exit only after the buffer has flushed to Chrome.
	process.stdout.write(Buffer.concat([header, json]), () => process.exit(exitCode));
}

const chunks = [];
process.stdin.on("data", (d) => {
	chunks.push(d);
	const buf = Buffer.concat(chunks);
	if (buf.length < 4) return; // header not complete yet
	const len = buf.readUInt32LE(0);
	if (buf.length < 4 + len) return; // body not complete yet
	const body = buf.subarray(4, 4 + len).toString("utf8");
	try {
		const msg = JSON.parse(body);
		const names = writeCookieFile(msg.cookies);
		reply({ ok: true, wrote: COOKIE_FILE, names }, 0);
	} catch (err) {
		reply({ ok: false, error: String(err?.message ?? err) }, 1);
	}
});
process.stdin.on("end", () => process.exit(0));
