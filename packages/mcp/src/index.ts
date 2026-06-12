#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveConfig } from './config'
import { buildServer } from './server'

/**
 * drk-mcp — stdio MCP server for Docker Rescue Kit's Prune Guard.
 *
 * Distributed as a thin node:alpine image for the Docker MCP Catalog; agents
 * (Claude, Cursor, …) launch it over stdio. It snapshots volumes via the DRK
 * backend, then performs destructive Docker ops directly — snapshot-then-act.
 *
 * stdout is reserved for the MCP JSON-RPC stream; all logging goes to stderr.
 */
async function main(): Promise<void> {
  const cfg = resolveConfig()
  if (!cfg.drkApiKey) {
    process.stderr.write(
      '[drk-mcp] WARNING: DRK_API_KEY is not set. Guard snapshot calls to the DRK backend will fail ' +
        '(401). Set DRK_API_KEY (and DRK_URL if not http://localhost:42880).\n',
    )
  }
  const server = buildServer(cfg)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[drk-mcp] connected over stdio; DRK_URL=${cfg.drkUrl}\n`)
}

main().catch(err => {
  process.stderr.write(`[drk-mcp] fatal: ${err?.stack || err?.message || String(err)}\n`)
  process.exit(1)
})
