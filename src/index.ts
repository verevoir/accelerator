import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSourceTools } from './tools/source.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { loadInstructions } from './instructions.js';
import { loadManifest, composeInstructions } from './manifest.js';

/** Construct and configure the accelerator MCP server — the commodity dev-tool
 * surface: cached source reads/writes (@verevoir/context) and work-tracker
 * operations (@verevoir/workflows). The governed moat (provision / enact /
 * delegate / dispatch / loop) lives in `@verevoir/capabilities`, which composes
 * on top of this package's substrate; a host wanting both launches both servers.
 *
 * The substrate and LLM/telemetry/loop primitives are also exposed as library
 * subpath exports (see package.json `exports`), so `@verevoir/capabilities`
 * imports them (`@verevoir/accelerator/tiers`, `/router`, `/audit`, …) rather
 * than re-implementing them — the `capabilities -> accelerator` dependency
 * direction that keeps governance out of the commodity layer. */
export async function createServer(): Promise<McpServer> {
  const server = new McpServer(
    { name: 'verevoir-accelerator', version: '0.1.0' },
    // Server-level guidance the client injects on connect — steers an agent to
    // prefer these cached, indexed tools over its built-in filesystem/shell.
    // No manifest (aigency.json) -> the universal doctrine only.
    { instructions: composeInstructions(loadInstructions(), loadManifest()) }
  );

  registerSourceTools(server);
  registerWorkflowTools(server);

  return server;
}
