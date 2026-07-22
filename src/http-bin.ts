#!/usr/bin/env node
import { startHttp } from './http.js';

// One long-lived accelerator process serving many MCP sessions over HTTP, so
// they share a single warm cache / tree-sitter index (the stdio server is one
// process per client and cannot). Binds 127.0.0.1 unless HOST says otherwise —
// exposing it off-box is a hosting decision the operator makes explicitly.
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

startHttp({ port, host })
  .then(({ url }) => {
    process.stderr.write(`verevoir-accelerator: HTTP MCP listening on ${url}\n`);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `verevoir-accelerator: fatal error starting HTTP server: ${String(err)}\n`
    );
    process.exit(1);
  });
