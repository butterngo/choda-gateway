#!/usr/bin/env node
// Spike-1: baseline latency client → MCP child (NO gateway)
// Usage: node scripts/spike-1-baseline.mjs [--warmup=N] [--measured=N] [--out=file.jsonl]

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { performance } from 'node:perf_hooks'
import { writeFileSync, appendFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)

const WARMUP = Number(args.warmup ?? 200)
const MEASURED = Number(args.measured ?? 500)
const OUT = args.out ?? null
const UPSTREAM = 'C:\\dev\\choda-deck\\dist\\mcp-server.cjs'

const env = {
  ...process.env,
  CHODA_DATA_DIR: 'C:\\dev\\choda-deck\\data',
  CHODA_CONTENT_ROOT: 'C:\\Users\\hngo1_mantu\\vault'
}

function log(...a) { process.stderr.write(a.join(' ') + '\n') }

const transport = new StdioClientTransport({
  command: 'node',
  args: [UPSTREAM],
  env
})

const client = new Client({ name: 'spike-1-baseline', version: '0.0.0' }, { capabilities: {} })

log(`[spike-1] upstream=${UPSTREAM}`)
log(`[spike-1] warmup=${WARMUP} measured=${MEASURED}`)

const t_connect_start = performance.now()
await client.connect(transport)
const connectMs = performance.now() - t_connect_start
log(`[spike-1] connected in ${connectMs.toFixed(1)}ms`)

const tools = await client.listTools()
log(`[spike-1] upstream exposes ${tools.tools.length} tools`)

const callOnce = async () => {
  const t0 = performance.now()
  let ok = true
  let errMsg = null
  try {
    await client.callTool({ name: 'task_list', arguments: { status: 'READY', limit: 1 } })
  } catch (e) {
    ok = false
    errMsg = String(e?.message ?? e)
  }
  return { dur_ms: performance.now() - t0, ok, err: errMsg }
}

// Warm-up (not recorded)
log(`[spike-1] warm-up start`)
for (let i = 0; i < WARMUP; i++) {
  const r = await callOnce()
  if (!r.ok) {
    log(`[spike-1] warm-up FAIL at i=${i}: ${r.err}`)
    process.exit(1)
  }
}
log(`[spike-1] warm-up done`)

// Measured (recorded)
if (OUT) writeFileSync(OUT, '')
log(`[spike-1] measured start`)
const runStart = new Date().toISOString()
const sample = []
let failures = 0
for (let i = 0; i < MEASURED; i++) {
  const r = await callOnce()
  if (!r.ok) failures++
  const row = {
    i,
    dur_ms: r.dur_ms,
    ok: r.ok,
    err: r.err,
    ts: new Date().toISOString()
  }
  sample.push(row)
  const line = JSON.stringify(row) + '\n'
  if (OUT) appendFileSync(OUT, line)
  else process.stdout.write(line)
}
const runEnd = new Date().toISOString()
log(`[spike-1] measured done — failures=${failures}/${MEASURED}`)

// Quick summary to stderr (full analysis in spike-1-report.mjs)
const okDur = sample.filter(r => r.ok).map(r => r.dur_ms).sort((a, b) => a - b)
const pct = p => okDur[Math.min(okDur.length - 1, Math.floor(p * okDur.length))]
log(`[spike-1] summary p50=${pct(0.5).toFixed(1)}ms p95=${pct(0.95).toFixed(1)}ms p99=${pct(0.99).toFixed(1)}ms`)
log(`[spike-1] run window: ${runStart} → ${runEnd}`)

await client.close()
process.exit(0)
