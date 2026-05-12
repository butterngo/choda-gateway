// Verifies the no-silent-fallback gate.
// - libsodium init is simulated to fail (-ForceFail flag).
// - Without GATEWAY_ALLOW_CRYPTO_FALLBACK=1 → process throws + exits 1.
// - With GATEWAY_ALLOW_CRYPTO_FALLBACK=1 → switches to node:crypto, prints the
//   chosen backend so the swap is visible (NOT silent).
import crypto from "node:crypto";

const forceFail = process.argv.includes("-ForceFail");
const allowFallback = process.env.GATEWAY_ALLOW_CRYPTO_FALLBACK === "1";

async function initLibsodium() {
	if (forceFail) {
		throw new Error("simulated libsodium init failure");
	}
	const sodium = (await import("libsodium-wrappers-sumo")).default;
	await sodium.ready;
}

try {
	await initLibsodium();
	process.stdout.write("crypto-backend: libsodium\n");
} catch (err) {
	if (!allowFallback) {
		process.stderr.write(
			`ERROR: libsodium init failed and GATEWAY_ALLOW_CRYPTO_FALLBACK not set: ${err.message}\n`,
		);
		process.exit(1);
	}
	process.stdout.write("crypto-backend: node:crypto (explicit fallback)\n");
	const key = crypto.scryptSync("spike-pwd", "spike-salt", 32);
	const nonce = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
	const enc = Buffer.concat([cipher.update("hello", "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	process.stdout.write(
		`node:crypto encrypted ${enc.length} bytes (auth tag ${tag.length}B)\n`,
	);
}
