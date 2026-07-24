import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './index.js';

/** Authorization seam for a HOSTED deployment.
 *
 * The stdio server is one process per client, so its cache is private by
 * construction. This HTTP server is one process serving MANY sessions that
 * share the module-singleton `contextStore` — that sharing is the point (a
 * fan-out of subagents parses a repo once, not N times), but it also means a
 * hosted, multi-tenant instance must not serve one caller's cached content to
 * another. Route 1 (local, single trusted user) leaves this open. Hosting it
 * supplies `authorize` to authenticate the caller at the endpoint — and, for
 * true multi-tenant isolation, must additionally scope each cache READ to the
 * caller's authorised sources (a `contextStore`-level check, not just this
 * gate), since the cache key `{sourceId, version, itemId}` carries no tenant.
 * That cache-read scoping and per-caller rate limiting are the accepted, tracked
 * scope of the hosting work (STDIO-599, Route 2) — deferred deliberately, not
 * left implicitly open; Route 1 binds loopback for a single trusted caller. */
export type Authorize = (req: IncomingMessage) => boolean | Promise<boolean>;

export interface HttpServerOptions {
  /** Endpoint path the MCP transport is served on. Default `/mcp`. */
  path?: string;
  /** Endpoint authentication for a hosted deployment. Default: allow (local). */
  authorize?: Authorize;
  /** Cap on a request body before it is rejected, in bytes. Default 4 MiB. */
  maxBodyBytes?: number;
  /** Hard cap on concurrently-tracked sessions. Bounds the transport map so it
   * cannot grow without limit; new sessions past the cap get 503. Default 1024.
   * This is a single global bound; per-caller / per-IP throttling belongs with
   * the hosted, authenticated deployment (STDIO-599, Route 2), where an
   * untrusted caller exists — Route 1 is loopback and single-tenant. */
  maxSessions?: number;
  /** Time a client may take to deliver a full request before the socket is cut,
   * in ms — bounds a slow trickle that the byte cap can't. Default 30_000.
   * Does not limit an SSE response stream. */
  requestTimeoutMs?: number;
  /** Time budget for the `authorize` hook, in ms — a hosted hook that hangs is
   * treated as a denial (fail closed) rather than holding the slot. Default
   * 5_000. */
  authorizeTimeoutMs?: number;
  /** Idle time after which a session with NO request in flight is reaped, in
   * ms — reclaims a slot from a client that dropped without a clean shutdown. A
   * session mid-request (an open SSE stream counts) is never reaped, so an
   * active long-lived stream is safe. Default 30 min. */
  sessionIdleMs?: number;
  /** Combined time budget for the one-shot session-init (`createServer` +
   * `connect`), in ms — a hang there would hold the reserved slot; bounded so it
   * fails rather than blocks the cap. Does not apply to the SSE stream that
   * follows. Default 15_000. */
  initTimeoutMs?: number;
  /** Injection point for the per-session MCP server factory — defaults to the
   * package's `createServer`. Exists so the init failure path can be exercised
   * (and a host can substitute a pre-configured server). */
  createServerFn?: () => ReturnType<typeof createServer>;
}

export interface StartHttpOptions extends HttpServerOptions {
  port?: number;
  host?: string;
  /** How often the idle-session sweep runs, in ms. Default 60_000. */
  sweepMs?: number;
}

/** The endpoint handler plus the session-lifecycle control a host needs to run
 * it: {@link RequestHandler.reapIdle} evicts idle sessions (driven on a timer by
 * {@link startHttp}, callable directly in a test). */
export interface RequestHandler {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Reap every session idle for at least `idleMs`; returns the count reaped. */
  reapIdle: (idleMs: number, now?: number) => number;
}

// Sessions this server hands out are randomUUID()s; a header that isn't that
// shape can never name a live session, so it's rejected at the boundary rather
// than used as a lookup key.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SESSION_HEADER = 'mcp-session-id';

const rpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  error: { code, message },
  id: null,
});

// `closeConn` sets `Connection: close` so Node tears the socket down after the
// reply instead of keeping it alive. Used on body-read failures: an oversized
// body is aborted mid-stream, leaving unread bytes that would be misread as the
// next request's headers on a reused keep-alive connection.
function sendJson(res: ServerResponse, status: number, body: unknown, closeConn = false): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (closeConn) headers.connection = 'close';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

// Resolve `p` but reject if `ms` elapses first — bounds a caller-supplied hook
// so it cannot hold a handler slot on this shared process indefinitely.
function withTimeout<T>(p: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Buffer and JSON-parse a request body, bounded so a hostile or runaway client
// cannot stream unbounded memory into a shared, long-lived process (resilience).
async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error('request body exceeds limit');
    chunks.push(chunk as Buffer);
  }
  return size === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Build the request handler for the streamable-HTTP MCP endpoint. Each MCP
 * session gets its own `McpServer` (via `createServer`), but every session in
 * this process shares the one `contextStore` cache — the reason to run HTTP at
 * all. Exposed separately from {@link startHttp} so it can be tested or mounted
 * on an existing HTTP server. */
export function createRequestHandler(opts: HttpServerOptions = {}): RequestHandler {
  const path = opts.path ?? '/mcp';
  const maxBodyBytes = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  const maxSessions = opts.maxSessions ?? 1024;
  // Session id -> its transport, and -> its last-activity time. Mutated only on
  // the single-threaded event loop, so no locking is needed. Bounded two ways:
  // maxSessions (a hard count cap) and reapIdle (evicting sessions a dropped
  // client left behind), so neither a burst nor a leak grows it without limit.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lastSeen = new Map<string, number>();
  // Requests in flight per session — an open SSE stream keeps this above zero,
  // marking the session active so the idle reaper leaves it alone.
  const inFlight = new Map<string, number>();
  // Sessions past the cap check but not yet registered (the async window before
  // onsessioninitialized fires). Counted synchronously so concurrent inits can't
  // both slip past a cap that transports.size alone wouldn't yet reflect.
  let pending = 0;

  const drop = (id: string): void => {
    transports.delete(id);
    lastSeen.delete(id);
    inFlight.delete(id);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== path) {
      // Close: a POST to the wrong path also leaves its body unread on the socket.
      sendJson(res, 404, rpcError(-32601, 'not found'), true);
      return;
    }

    if (opts.authorize) {
      // Bound the hook and fail closed: a hosted authorize that hangs or throws
      // is a denial, never a held slot. handleRequest below is deliberately NOT
      // bounded — an SSE response stream is long-lived by design, and tool-call
      // duration is the tools' own concern, not the transport's.
      let allowed = false;
      try {
        allowed = await withTimeout(opts.authorize(req), opts.authorizeTimeoutMs ?? 5_000);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        // Close the connection: on a denied POST the body was never read, so
        // unread bytes would corrupt the next request on a reused socket.
        sendJson(res, 401, rpcError(-32001, 'unauthorized'), true);
        return;
      }
    }

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req, maxBodyBytes);
      } catch {
        // Close the connection: an oversized body left unread bytes on the
        // socket, and reusing it would corrupt the next request on it.
        sendJson(res, 400, rpcError(-32700, 'invalid or oversized request body'), true);
        return;
      }
    }

    const sessionId = req.headers[SESSION_HEADER] as string | undefined;
    if (sessionId !== undefined && !SESSION_ID_RE.test(sessionId)) {
      // Body already drained above, so no Connection: close is needed here.
      sendJson(res, 400, rpcError(-32600, 'invalid session id'));
      return;
    }
    const existing = sessionId ? transports.get(sessionId) : undefined;

    if (existing) {
      const id = sessionId as string;
      inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
      lastSeen.set(id, Date.now());
      try {
        await existing.handleRequest(req, res, body);
      } finally {
        // Refresh on completion (an SSE stream may have run for a long time) and
        // clear the in-flight mark so the reaper can consider it once idle.
        inFlight.set(id, (inFlight.get(id) ?? 1) - 1);
        lastSeen.set(id, Date.now());
      }
      return;
    }

    // A session that isn't yet known may only begin with an `initialize` POST.
    if (req.method === 'POST' && !sessionId && isInitializeRequest(body)) {
      if (transports.size + pending >= maxSessions) {
        sendJson(res, 503, rpcError(-32000, 'session capacity reached'), true);
        return;
      }
      // Hold the reservation across the async window below so a concurrent init
      // sees the slot as taken before onsessioninitialized registers it.
      pending += 1;
      // Explicit type: the onsessioninitialized closure below references
      // `transport` before assignment, so inference from the initializer alone
      // is circular.
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          lastSeen.set(id, Date.now());
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) drop(transport.sessionId);
      };
      try {
        // Bound the one-shot init (build + handshake) by a single shared
        // deadline; handleRequest that follows is deliberately unbounded — it
        // may be a long-lived SSE stream.
        const deadline = Date.now() + (opts.initTimeoutMs ?? 15_000);
        const factory = opts.createServerFn ?? createServer;
        const server = await withTimeout(factory(), Math.max(0, deadline - Date.now()));
        await withTimeout(server.connect(transport), Math.max(0, deadline - Date.now()));
        await transport.handleRequest(req, res, body);
      } catch (err) {
        // If connect/handshake fails after the session was registered, drop the
        // entry so a failed init can't leak a slot in this long-lived process.
        if (transport.sessionId) drop(transport.sessionId);
        throw err;
      } finally {
        pending -= 1;
      }
      return;
    }

    sendJson(res, 400, rpcError(-32000, 'no valid session — initialize first'));
  };

  const reapIdle = (idleMs: number, now = Date.now()): number => {
    let reaped = 0;
    for (const [id, seen] of lastSeen) {
      if ((inFlight.get(id) ?? 0) === 0 && now - seen >= idleMs) {
        const t = transports.get(id);
        drop(id);
        // Bound the close and make a failed teardown legible (the session is
        // already dropped, so this is graceful handling, not a hard error).
        if (t)
          void withTimeout(t.close(), 5_000).catch((e: unknown) =>
            process.stderr.write(
              `verevoir-accelerator http: idle-session teardown failed: ${String(e)}\n`
            )
          );
        reaped += 1;
      }
    }
    return reaped;
  };

  return { handle, reapIdle };
}

/** Start the accelerator MCP over streamable HTTP and return the running server.
 * Binds `127.0.0.1` by default: sharing the cache off-box is a deliberate
 * hosting decision, not a default, so a bare start is not silently reachable
 * from the network. */
export async function startHttp(opts: StartHttpOptions = {}): Promise<{
  server: Server;
  url: string;
  reapIdle: RequestHandler['reapIdle'];
  close: () => Promise<void>;
}> {
  const rh = createRequestHandler(opts);
  const server = createHttpServer((req, res) => {
    rh.handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'internal error'));
      process.stderr.write(`verevoir-accelerator http: ${String(err)}\n`);
    });
  });

  // Bound the time to receive a full request so a slow trickle can't hold a
  // handler slot on this shared process (the byte cap bounds memory, not time).
  // This covers receiving the request, not the reply, so an SSE response stream
  // is unaffected.
  server.requestTimeout = opts.requestTimeoutMs ?? 30_000;

  // Sweep idle sessions on a timer; unref so it never keeps the process alive.
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const sweeper = setInterval(() => rh.reapIdle(idleMs), opts.sweepMs ?? 60_000);
  sweeper.unref();

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    url: `http://${host}:${boundPort}${opts.path ?? '/mcp'}`,
    reapIdle: rh.reapIdle,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(sweeper);
        server.close((err) => (err ? reject(err) : resolve()));
        // Force held-open connections (long-lived SSE streams especially) shut,
        // or server.close() never fires its callback and this never resolves.
        server.closeAllConnections();
      }),
  };
}
