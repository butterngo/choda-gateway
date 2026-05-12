// CLI shim: get a secret. Prints raw value to stdout, error class+message to stderr.
import { getSecret } from "./spike-secret-store.mjs";

const PATH = "./secrets.enc";
const [name] = process.argv.slice(2);
if (!name) {
	process.stderr.write("usage: spike-secret-get.mjs <name>\n");
	process.exit(2);
}
const password = process.env.GATEWAY_SECRETS_PASSWORD;
if (!password) {
	process.stderr.write("GATEWAY_SECRETS_PASSWORD not set\n");
	process.exit(2);
}

try {
	const val = await getSecret(PATH, password, name);
	process.stdout.write(val);
} catch (err) {
	process.stderr.write(`ERROR: ${err.name ?? "Error"}: ${err.message}\n`);
	process.exit(1);
}
