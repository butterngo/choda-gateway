#!/usr/bin/env node
// Aggregate spike-1 JSONL runs into percentile table
// Usage: node scripts/spike-1-report.mjs <file1.jsonl> [file2.jsonl ...]

import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  process.stderr.write('usage: spike-1-report.mjs <file1.jsonl> [file2.jsonl ...]\n')
  process.exit(2)
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]

const allRuns = files.map(f => {
  const rows = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const okDur = rows.filter(r => r.ok).map(r => r.dur_ms).sort((a, b) => a - b)
  const failures = rows.length - okDur.length
  return {
    file: f,
    n: rows.length,
    failures,
    p50: pct(okDur, 0.5),
    p95: pct(okDur, 0.95),
    p99: pct(okDur, 0.99),
    min: okDur[0],
    max: okDur[okDur.length - 1],
    mean: okDur.reduce((a, b) => a + b, 0) / okDur.length
  }
})

// Reproducibility check
const p95s = allRuns.map(r => r.p95)
const p95min = Math.min(...p95s)
const p95max = Math.max(...p95s)
const p95mean = p95s.reduce((a, b) => a + b, 0) / p95s.length
const reproSpreadPct = ((p95max - p95min) / p95mean) * 100

const fmt = n => n.toFixed(2)

console.log('| run | n | failures | p50 ms | p95 ms | p99 ms | min ms | max ms | mean ms |')
console.log('|-----|---|----------|--------|--------|--------|--------|--------|---------|')
for (const r of allRuns) {
  console.log(`| ${r.file.split(/[\\/]/).pop()} | ${r.n} | ${r.failures} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.min)} | ${fmt(r.max)} | ${fmt(r.mean)} |`)
}
console.log('')
console.log(`Reproducibility: p95 min=${fmt(p95min)}ms max=${fmt(p95max)}ms mean=${fmt(p95mean)}ms spread=${fmt(reproSpreadPct)}%`)
console.log(`AC threshold p95 < 100ms: ${p95max < 100 ? 'PASS' : 'FAIL'} (worst-case p95=${fmt(p95max)}ms)`)
console.log(`AC threshold repro < 15%: ${reproSpreadPct < 15 ? 'PASS' : 'NOTE'} (spread=${fmt(reproSpreadPct)}%)`)
