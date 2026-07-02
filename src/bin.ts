#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';

const transport = new StdioServerTransport();

createServer()
  .then((server) => server.connect(transport))
  .catch((err: unknown) => {
    process.stderr.write(`verevoir-accelerator: fatal error during connect: ${String(err)}\n`);
    process.exit(1);
  });
