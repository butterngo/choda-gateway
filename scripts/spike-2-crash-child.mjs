#!/usr/bin/env node
// Test-only MCP child for Spike-2 crash isolation.
// Tool: __crash — calls process.exit(101)
// Tool: __idle — returns immediately (so we have a sane no-op to spawn-and-wait on)

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'spike-2-crash-child', version: '0.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: '__crash', description: 'Crash the server with exit code 101', inputSchema: { type: 'object' } },
    { name: '__idle', description: 'No-op', inputSchema: { type: 'object' } }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === '__crash') {
    process.stderr.write('[crash-child] __crash invoked → exit(101)\n')
    // Give the response a chance to ship before crashing? Skip — we want hard crash mid-request.
    setImmediate(() => process.exit(101))
    return { content: [{ type: 'text', text: 'crashing' }] }
  }
  if (req.params.name === '__idle') {
    return { content: [{ type: 'text', text: 'idle ok' }] }
  }
  throw new Error('unknown tool: ' + req.params.name)
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[crash-child] ready pid=${process.pid}\n`)
