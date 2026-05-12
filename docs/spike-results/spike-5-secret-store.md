# Spike-5: Local secret store — libsodium on Windows

**Date:** 2026-05-12
**Task:** TASK-692
**Session:** SESSION-1778571699087-1
**Platform:** Windows 11 Enterprise · Node 24.14.0 · pnpm 10.33.0
**Runner:** automated (`scripts/spike-secret-*.mjs`)

## Question

Does libsodium WASM run on Windows without native compile, are Argon2id key
derivation + XChaCha20-Poly1305 IETF authenticated encryption usable as a local
secret store, and is the "no-silent-fallback" gate enforceable end-to-end?

## Method

Implement a minimal end-to-end secret store on top of libsodium and exercise the
3 AC tests + 1 fallback-gate test in real separate Node processes (not in-VM
mocks). All decisions pre-chosen by Copilot Q3 are honoured:

| Aspect | Decision | Where verified |
|---|---|---|
| KDF | Argon2id via `crypto_pwhash` | `deriveKey()` uses `crypto_pwhash_ALG_ARGON2ID13` |
| KDF params | INTERACTIVE (opslimit=2, memlimit=64MB) | written into header bytes 6–21 |
| Salt | Random 16 bytes, file-level | bytes 22–37 of `secrets.enc` |
| Cipher | XChaCha20-Poly1305 IETF | `crypto_aead_xchacha20poly1305_ietf_encrypt/decrypt` |
| Nonce | Random 24 bytes per entry | `randombytes_buf(24)` per `set` |
| Password source | `GATEWAY_SECRETS_PASSWORD` env | CLI shims |
| OS keychain (DPAPI) | Deferred Phase 2 | not implemented |
| Fallback to node:crypto | Explicit only, gated by `GATEWAY_ALLOW_CRYPTO_FALLBACK=1` | `spike-fallback-test.mjs` |

### File format `secrets.enc` (38-byte fixed header + JSONL body)

```
offset  bytes  field
0       6      MAGIC = "CGSS01"
6       16     KDF_PARAMS  (opslimit u64 LE | memlimit u64 LE)
22      16     SALT
38      1      '\n'
39…     N      ENTRIES, one JSON object per line:
                 { "name": "<utf8>", "nonce": "<base64 24B>", "ct": "<base64>" }
```

### Code

- [`scripts/spike-secret-store.mjs`](../../scripts/spike-secret-store.mjs) — core (`init` / `setSecret` / `getSecret` / `listSecrets`)
- [`scripts/spike-secret-set.mjs`](../../scripts/spike-secret-set.mjs) — CLI shim: set
- [`scripts/spike-secret-get.mjs`](../../scripts/spike-secret-get.mjs) — CLI shim: get
- [`scripts/spike-bench-libsodium-init.mjs`](../../scripts/spike-bench-libsodium-init.mjs) — cold-start WASM bench
- [`scripts/spike-fallback-test.mjs`](../../scripts/spike-fallback-test.mjs) — no-silent-fallback gate verifier

## Evidence

### Finding 0 — package selection: SUMO required

Copilot Q3 spec'd `libsodium-wrappers@0.8.4`, but the slim package does **not**
export `crypto_pwhash*` (Argon2id) — confirmed by listing keys after
`await sodium.ready` (`Object.keys` returned zero pwhash keys, OPSLIMIT/MEMLIMIT/
ALG_ARGON2ID13 all `undefined`).

Resolution: switched to **`libsodium-wrappers-sumo@0.8.4`** (same lib family,
includes the full algorithm set). No native compile either — still pure WASM.
Phase 1 production code should use `-sumo`. Update ADR-001 accordingly.

### Install (AC: no node-gyp)

```
+ libsodium-wrappers-sumo 0.8.4
```

- `Test-Path node_modules/libsodium-wrappers-sumo/build` → `False` ✓
- `grep -i gyp install.log` → no match ✓

### WASM cold-start (AC: <500ms)

3 separate `node scripts/spike-bench-libsodium-init.mjs` invocations
(sumo variant, after switch):

| run | ms |
|-----|----|
| 1 | 22.073 |
| 2 | 7.295 |
| 3 | 6.393 |
| **average** | **11.92 ms** |
| **worst case** | **22.07 ms** |

→ `< 500ms` PASS (~22× margin worst case, ~42× margin average). The first run
loads more (V8 WASM compile cost on cold disk cache); subsequent inits drop to
single-digit ms because the WASM blob is OS-cached.

### Roundtrip (AC: set in proc-A, restart, get in proc-B → exact match)

```
$ export GATEWAY_SECRETS_PASSWORD='test-password-1'
$ node scripts/spike-secret-set.mjs LINEAR_API_KEY secret123
set LINEAR_API_KEY
$ wc -c secrets.enc
152 secrets.enc
$ node scripts/spike-secret-get.mjs LINEAR_API_KEY
secret123
```

→ Two separate Node processes, second one returns exact `secret123` PASS.

### Wrong password (AC: DecryptError + file SHA unchanged)

```
SHA256 before: 7cded32f1e05d2a996ff92a9edc1f2dbb451977c07d0ae89ebee6a697df920fe

$ GATEWAY_SECRETS_PASSWORD='WRONG-password-2' node scripts/spike-secret-get.mjs LINEAR_API_KEY
ERROR: DecryptError: failed to decrypt entry 'LINEAR_API_KEY': ciphertext cannot be decrypted using that key
(exit=1)

SHA256 after:  7cded32f1e05d2a996ff92a9edc1f2dbb451977c07d0ae89ebee6a697df920fe
SHA UNCHANGED ✓
```

→ `DecryptError` raised cleanly (named class), exit code 1, file untouched PASS.

### Plaintext leak + MAGIC bytes (AC: no plaintext, MAGIC = "CGSS01")

```
$ grep -a 'secret123' secrets.enc
(no match) ✓

$ od -A n -c -N 6 secrets.enc
   C   G   S   S   0   1

$ od -A n -t u1 -N 6 secrets.enc
  67  71  83  83  48  49      (= ASCII "CGSS01")
```

→ Encryption verified — plaintext absent, header well-formed PASS.

### No-silent-fallback gate (AC: throws without env, switches with env=1)

```
$ unset GATEWAY_ALLOW_CRYPTO_FALLBACK
$ node scripts/spike-fallback-test.mjs -ForceFail
ERROR: libsodium init failed and GATEWAY_ALLOW_CRYPTO_FALLBACK not set: simulated libsodium init failure
(exit=1)

$ export GATEWAY_ALLOW_CRYPTO_FALLBACK=1
$ node scripts/spike-fallback-test.mjs -ForceFail
crypto-backend: node:crypto (explicit fallback)
node:crypto encrypted 5 bytes (auth tag 16B)
(exit=0)
```

→ Without env: process refuses to run on simulated libsodium failure.
With env=1: switch to AES-256-GCM is **announced on stdout** before any crypto
work — operator visibility maintained. PASS.

### AC matrix

| AC item | Expected | Observed | Status |
|---|---|---|---|
| Install no node-gyp | no `build/` dir, no `gyp` in install log | both empty | **PASS** |
| WASM init <500ms (avg 3 runs) | <500ms | 11.92 ms avg, 22.07 ms worst | **PASS** |
| Roundtrip exact match | `secret123` | `secret123` | **PASS** |
| Wrong password → DecryptError | named error + parent alive | `DecryptError` thrown, exit 1 | **PASS** |
| File SHA unchanged on wrong pwd | equal before/after | identical | **PASS** |
| No plaintext leak | `grep secret123` → no match | no match | **PASS** |
| MAGIC bytes "CGSS01" | `67 71 83 83 48 49` | `67 71 83 83 48 49` | **PASS** |
| No silent fallback | throws without env | throws with clear msg | **PASS** |
| Explicit fallback | announced switch on stdout | "crypto-backend: node:crypto (explicit fallback)" | **PASS** |

## Decision

**Go for Phase 1 production secret store (TASK-694).**

libsodium-wrappers-sumo is the right primitive on Windows: zero native build,
WASM cold-start ~10ms (negligible vs gateway startup budget), Argon2id +
XChaCha20-Poly1305 IETF behave correctly across separate Node processes, and
the no-silent-fallback gate enforces the operator-visibility property the
threat model requires. The slim → sumo finding is a one-line dependency swap;
Copilot Q3 should be re-read with this correction.

### Caveats

- **Node version drift:** `package.json` declares `engines.node: 22.x`; this
  spike ran on **24.14.0** (pnpm only `WARN`s, doesn't block). Re-run the same
  AC suite on Node 22.x in Phase 1 CI for production validation. Pure-JS WASM
  semantics shouldn't differ, but verify rather than assume.
- **Single-process spike:** no concurrent reader/writer test. TASK-694 should
  add at least one test that runs `set` and `get` overlapping in time to verify
  the JSONL append + read is safe — current implementation reads the whole file
  on every `get` so the only risk is a half-written line, which is unlikely
  given `appendFileSync`.
- **Argon2id INTERACTIVE chosen for the spike** (~50ms per derive). For a local
  store accessed at gateway startup + on each secret-rotation it's fine; if the
  threat model later requires SENSITIVE (~500ms+), the file header already
  records the params so old stores stay readable after the policy change.

### Follow-ups recorded for Phase 1 (TASK-694)

- Replace `libsodium-wrappers` with `libsodium-wrappers-sumo` in package.json.
  Update ADR-001 secret-store section to name the sumo variant explicitly.
- Port `init / setSecret / getSecret / listSecrets` from the spike into
  `src/secrets/store.ts` with a proper `SecretStore` interface and the
  lazy-decrypt semantic the task body calls for.
- Add Node-22 CI run of the AC suite.
- Add the concurrent reader/writer test described above.
- Wire the no-silent-fallback gate so production code consults
  `GATEWAY_ALLOW_CRYPTO_FALLBACK` (and emits a structured warning) instead of
  the spike's stdout print.

## Related

- ADR-001: Architecture overview (secret store layer — needs sumo correction)
- TASK-688: Setup repo (blocker — DONE)
- TASK-694: Implement production secret store (will port spike code)
- Conversation: CONV-1778389705280-1, MSG-1778403989870-14 (Copilot Q3)
- Conversation: CONV-1778480535010-1 (phase-0 review)
