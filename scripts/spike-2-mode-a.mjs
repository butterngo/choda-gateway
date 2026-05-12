#!/usr/bin/env node
// Spike-2 Mode A: child self-crashes via tool, verify spike script survives.
//
// Setup:
//   - Spawn crash-child via MCP SDK (StdioClientTransport)
//   - Subscribe to child exit BEFORE invoking __crash
//   - Call __crash → child runs process.exit(101)
//   - Assert: spike script PID unchanged + child exit code = 101
//
// Pass: spike script still alive after child dies, exit code observed = 101.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CHILD = resolve(__dirname, 'spike-2-crash-child.mjs')

const log = (...a) => process.stderr.write('[mode-a] ' + a.join(' ') + '\n')

const parentPidBefore = process.pid
log(`parent pid (before) = ${parentPidBefore}`)

const transport = new StdioClientTransport({ command: 'node', args: [CHILD] })
const client = new Client({ name: 'spike-2-mode-a', version: '0.0.0' }, { capabilities: {} })

await client.connect(transport)
log('connected')

// _process is populated after start() (which connect() calls)
let childExitInfo = null
const childProc = transport._process
if (!childProc) {
  log('FAIL: cannot access underlying child process from transport — SDK shape changed')
  process.exit(2)
}
childProc.on('exit', (code, signal) => {
  childExitInfo = { exitCode: code, signalCode: signal }
  log(`child exit observed → exitCode=${code} signalCode=${signal}`)
})

const tools = await client.listTools()
log(`child exposes ${tools.tools.length} tools: ${tools.tools.map(t => t.name).join(', ')}`)

let crashCallError = null
try {
  await client.callTool({ name: '__crash', arguments: {} })
  log('WARN: __crash returned without error — unexpected (child should have died)')
} catch (e) {
  crashCallError = String(e?.message ?? e)
  log(`__crash call rejected (expected): ${crashCallError}`)
}

// Wait up to 2s for exit event to fire
const start = Date.now()
while (childExitInfo === null && Date.now() - start < 2000) {
  await new Promise(r => setTimeout(r, 20))
}

const parentPidAfter = process.pid
log(`parent pid (after) = ${parentPidAfter}`)

const result = {
  mode: 'A',
  parentPidBefore,
  parentPidAfter,
  parentAlive: parentPidBefore === parentPidAfter,
  childExit: childExitInfo,
  crashCallError,
  pass:
    parentPidBefore === parentPidAfter &&
    childExitInfo !== null &&
    childExitInfo.exitCode === 101
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n')
log(`PASS=${result.pass}`)
process.exit(result.pass ? 0 : 1)
