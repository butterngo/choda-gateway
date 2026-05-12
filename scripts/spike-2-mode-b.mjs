#!/usr/bin/env node
// Spike-2 Mode B: parent force-kills upstream, verify spike script survives.
//
// Setup:
//   - Spawn upstream MCP child (real choda-deck server) via MCP SDK
//   - Wait for ready (one tools/list round-trip)
//   - Capture ChildProcess ref from transport
//   - Call child.kill('SIGKILL') — cross-platform, Node emulates on Windows
//   - Listen for exit, log exitCode + signalCode
//   - Assert: spike script PID unchanged, kill observed
//
// No platform fork — one path.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const UPSTREAM = 'C:\\dev\\choda-deck\\dist\\mcp-server.cjs'
const log = (...a) => process.stderr.write('[mode-b] ' + a.join(' ') + '\n')

const parentPidBefore = process.pid
log(`parent pid (before) = ${parentPidBefore}`)

const transport = new StdioClientTransport({
  command: 'node',
  args: [UPSTREAM],
  env: {
    ...process.env,
    CHODA_DATA_DIR: 'C:\\dev\\choda-deck\\data',
    CHODA_CONTENT_ROOT: 'C:\\Users\\hngo1_mantu\\vault'
  }
})

const client = new Client({ name: 'spike-2-mode-b', version: '0.0.0' }, { capabilities: {} })

await client.connect(transport)
log('connected')

let childExitInfo = null
const childProc = transport._process
if (!childProc) {
  log('FAIL: cannot access underlying child process from transport')
  process.exit(2)
}
childProc.on('exit', (code, signal) => {
  childExitInfo = { exitCode: code, signalCode: signal }
  log(`child exit observed → exitCode=${code} signalCode=${signal}`)
})

// Confirm child is healthy with one real call
const tools = await client.listTools()
log(`child exposes ${tools.tools.length} tools — healthy before kill`)
const childPid = childProc.pid
log(`child pid = ${childPid}`)

// Force-kill — cross-platform path
log(`sending SIGKILL to child`)
const killed = childProc.kill('SIGKILL')
log(`kill() returned ${killed}`)

// Wait up to 2s for exit
const start = Date.now()
while (childExitInfo === null && Date.now() - start < 2000) {
  await new Promise(r => setTimeout(r, 20))
}

const parentPidAfter = process.pid
log(`parent pid (after) = ${parentPidAfter}`)

const result = {
  mode: 'B',
  parentPidBefore,
  parentPidAfter,
  parentAlive: parentPidBefore === parentPidAfter,
  childPid,
  childExit: childExitInfo,
  // On Windows Node emulates signals — expected: exitCode != null, signalCode might be null OR 'SIGKILL'
  // On POSIX: exitCode null, signalCode 'SIGKILL'
  // AC: log both, pass if child terminated + parent alive
  pass: parentPidBefore === parentPidAfter && childExitInfo !== null
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n')
log(`PASS=${result.pass}`)
process.exit(result.pass ? 0 : 1)
