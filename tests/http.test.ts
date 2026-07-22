import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../src/http.js';

// Drive the HTTP transport through a real MCP client — the new surface is the
// transport and its session multiplexing, so the tests connect over the wire
// rather than poke internals. These prove many sessions live on one process
// (the substrate that makes the cache shared), the client-facing rejections
// (unauthorized, no/unknown/malformed session, oversized or malformed body,
// wrong path, the session cap), and the init-failure path (500 + slot reclaim,
// via an injected failing factory). Cache-hit behaviour itself is covered by
// e2e-cache-coherence.

const initRequest = (id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0.0.0' },
  },
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('accelerator HTTP transport — one process, many sessions', () => {
  it('serves the source tools to a client connecting over HTTP', async () => {
    const { url, close } = await startHttp({});
    const client = new Client({ name: 'test-a', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('read_file');
    } finally {
      await client.close();
      await close();
    }
  });

  it('gives two concurrent clients distinct sessions on the one server', async () => {
    const { url, close } = await startHttp({});
    const a = new Client({ name: 'a', version: '0.0.0' });
    const b = new Client({ name: 'b', version: '0.0.0' });
    const ta = new StreamableHTTPClientTransport(new URL(url));
    const tb = new StreamableHTTPClientTransport(new URL(url));
    try {
      await a.connect(ta);
      await b.connect(tb);
      expect((await a.listTools()).tools.length).toBeGreaterThan(0);
      expect((await b.listTools()).tools.length).toBeGreaterThan(0);
      expect(ta.sessionId).toBeDefined();
      expect(tb.sessionId).toBeDefined();
      expect(ta.sessionId).not.toBe(tb.sessionId);
    } finally {
      await a.close();
      await b.close();
      await close();
    }
  });

  it('rejects a caller the authorize hook denies — the endpoint gate a hosted deployment adds', async () => {
    const { url, close } = await startHttp({ authorize: () => false });
    const client = new Client({ name: 'denied', version: '0.0.0' });
    try {
      await expect(
        client.connect(new StreamableHTTPClientTransport(new URL(url)))
      ).rejects.toThrow();
    } finally {
      await client.close().catch(() => {});
      await close();
    }
  });

  it('rejects a non-initialize request that carries no session (400)', async () => {
    const { url, close } = await startHttp({});
    try {
      const res = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('rejects a malformed session id at the boundary (400) — not a UUID, never a live session', async () => {
    const { url, close } = await startHttp({});
    try {
      const res = await post(url, initRequest(), { 'mcp-session-id': 'no-such-session' });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('rejects a well-formed but unknown session id (400)', async () => {
    const { url, close } = await startHttp({});
    try {
      const res = await post(url, initRequest(), {
        'mcp-session-id': '00000000-0000-4000-8000-000000000000',
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('fails closed when the authorize hook throws (denied, not admitted)', async () => {
    const { url, close } = await startHttp({
      authorize: () => {
        throw new Error('boom');
      },
    });
    const client = new Client({ name: 'thrower', version: '0.0.0' });
    try {
      await expect(
        client.connect(new StreamableHTTPClientTransport(new URL(url)))
      ).rejects.toThrow();
    } finally {
      await client.close().catch(() => {});
      await close();
    }
  });

  it('fails closed when the authorize hook exceeds its timeout — a slow yes is still denied', async () => {
    const { url, close } = await startHttp({
      authorizeTimeoutMs: 20,
      authorize: () => new Promise<boolean>((r) => setTimeout(() => r(true), 200)),
    });
    const client = new Client({ name: 'slow-auth', version: '0.0.0' });
    try {
      await expect(
        client.connect(new StreamableHTTPClientTransport(new URL(url)))
      ).rejects.toThrow();
    } finally {
      await client.close().catch(() => {});
      await close();
    }
  });

  it('rejects a body over the configured size limit (400)', async () => {
    const { url, close } = await startHttp({ maxBodyBytes: 64 });
    try {
      const res = await post(url, { ...initRequest(), pad: 'x'.repeat(1024) });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('rejects a malformed JSON body (400)', async () => {
    const { url, close } = await startHttp({});
    try {
      const res = await post(url, '{ not valid json');
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('returns 404 for a path other than the MCP endpoint', async () => {
    const { url, close } = await startHttp({});
    try {
      const res = await fetch(url.replace(/\/mcp$/, '/nope'));
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it('close() resolves even while a client holds a live connection', async () => {
    const { url, close } = await startHttp({});
    const client = new Client({ name: 'holder', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    // Do NOT close the client first: close() must resolve by forcing the held
    // connection shut, not hang on it.
    let timer: ReturnType<typeof setTimeout>;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('close() hung')), 5000);
    });
    try {
      await expect(Promise.race([close(), hung])).resolves.toBeUndefined();
    } finally {
      clearTimeout(timer!);
      await client.close().catch(() => {});
    }
  });

  it('refuses a new session past the cap (503)', async () => {
    const { url, close } = await startHttp({ maxSessions: 1 });
    const client = new Client({ name: 'first', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const res = await post(url, initRequest(2));
      expect(res.status).toBe(503);
    } finally {
      await client.close().catch(() => {});
      await close();
    }
  });

  it('holds the cap under concurrent inits — no race admits two past maxSessions', async () => {
    const { url, close } = await startHttp({ maxSessions: 1 });
    try {
      const [a, b] = await Promise.all([post(url, initRequest(1)), post(url, initRequest(2))]);
      // Exactly one is admitted and one refused with 503 — never two sessions.
      expect([a.status, b.status].filter((s) => s === 503).length).toBe(1);
    } finally {
      await close();
    }
  });

  it('returns 500 and reclaims the slot when session init fails', async () => {
    const { url, close } = await startHttp({
      maxSessions: 1,
      createServerFn: () => Promise.reject(new Error('init boom')),
    });
    try {
      // Init fails -> 500 wrapper fires, and the reserved slot is released...
      expect((await post(url, initRequest(1))).status).toBe(500);
      // ...so a second init reaches init again (500, not a stuck 503).
      expect((await post(url, initRequest(2))).status).toBe(500);
    } finally {
      await close();
    }
  });

  it('reaps an idle session (nothing in flight) and reclaims its slot', async () => {
    const { url, close, reapIdle } = await startHttp({ maxSessions: 1 });
    try {
      // Raw init POST: the session is created but no stream is held, so it is
      // idle with nothing in flight the moment the POST completes.
      const res = await post(url, initRequest(1));
      expect(res.headers.get('mcp-session-id')).toBeTruthy();
      expect((await post(url, initRequest(2))).status).toBe(503); // cap held
      expect(reapIdle(0)).toBe(1); // idle -> reaped
      // Slot reclaimed: a fresh client is admitted.
      const client = new Client({ name: 'after', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await client.close();
    } finally {
      await close();
    }
  });

  it('never reaps a session with a request in flight — an active SSE stream is safe', async () => {
    const { url, close, reapIdle } = await startHttp({});
    const controller = new AbortController();
    try {
      const sid = (await post(url, initRequest(1))).headers.get('mcp-session-id') ?? '';
      // Hold an SSE GET open so a request is in flight for that session.
      await fetch(url, {
        method: 'GET',
        headers: { 'mcp-session-id': sid, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      expect(reapIdle(0)).toBe(0); // in flight -> protected despite idleMs 0
    } finally {
      controller.abort();
      await close();
    }
  });
});
