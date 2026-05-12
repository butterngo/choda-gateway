// CLI shim: set a secret (auto-init store if missing). Used by spike test recipe.
import { existsSync } from "node:fs";
import { init, setSecret } from "./spike-secret-store.mjs";

const PATH = "./secrets.enc";
const [name, value] = process.argv.slice(2);
if (!name || value === undefined) {
	process.stderr.write("usage: spike-secret-set.mjs <name> <value>\n");
	process.exit(2);
}
const password = process.env.GATEWAY_SECRETS_PASSWORD;
if (!password) {
	process.stderr.write("GATEWAY_SECRETS_PASSWORD not set\n");
	process.exit(2);
}

if (!existsSync(PATH)) {
	await init(PATH, password);
}
await setSecret(PATH, password, name, value);
process.stdout.write(`set ${name}\n`);
