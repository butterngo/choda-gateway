// Bench cold-start `await sodium.ready` in a fresh Node process.
// Prints a single float (ms) on stdout.
import sodium from "libsodium-wrappers-sumo";

const t0 = process.hrtime.bigint();
await sodium.ready;
const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;
process.stdout.write(`${ms.toFixed(3)}\n`);
