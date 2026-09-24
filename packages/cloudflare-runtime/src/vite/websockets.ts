import * as NodeHttp from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type * as vite from "vite";
import { proxyRequestHeaders, resolveForwardedHost } from "./forwarded-host.ts";

/**
 * Handles 'upgrade' requests on the Vite HTTP server and forwards the
 * WebSocket handshake to the local workerd address as a raw HTTP upgrade.
 *
 * Returns a cleanup function that removes the listener (used on server restart).
 */
export function handleWebSocket(
  httpServer: vite.HttpServer,
  address: string | URL,
  proxySharedSecret: string,
): () => void {
  const upstreamBase = typeof address === "string" ? new URL(address) : address;

  // Sockets hijacked by an `upgrade` are not reaped by `server.closeAllConnections()`,
  // yet `server.close()` still waits on them — so a lingering proxied WebSocket blocks
  // the HTTP server from closing on restart. Track live sockets and destroy them in the
  // cleanup function to close deterministically.
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    // Unhandled socket errors crash Node.
    socket.on("error", () => socket.destroy());

    // The URL — and thus the Sandbox-origin check below — is built from the
    // resolved (forwarded) host, not the raw `Host` header. This diverges from
    // upstream, which keys the origin off `Host`; here it's intentional so a
    // tunnel-fronted Sandbox preview still matches. Direct Sandbox hits carry no
    // `X-Forwarded-Host`, so they fall back to `Host` and behave identically.
    const rawHost = resolveForwardedHost(request.headers, "localhost");
    const base = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
    const url = new URL(request.url ?? "/", base);

    const isViteRequest =
      request.headers["sec-websocket-protocol"]?.startsWith("vite") ?? false;
    const isSandboxRequest = hasSandboxOrigin(url.origin);

    // Vite handles its own HMR upgrades; forward Sandbox preview URLs anyway.
    if (isViteRequest && !isSandboxRequest) {
      return;
    }

    const target = new URL(url.pathname + url.search, upstreamBase);
    const upstream = NodeHttp.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: request.method,
      // Forward the client-facing host so the worker sees the URL the client
      // requested rather than the local workerd address.
      headers: proxyRequestHeaders(request, url, proxySharedSecret),
    });

    const cleanup = () => {
      upstream.destroy();
      socket.destroy();
    };

    upstream.on("error", cleanup);
    socket.on("close", () => upstream.destroy());

    upstream.on("response", (response) => {
      // The worker answered the handshake with an ordinary HTTP response
      // (401, 403, 404, 500, ...) instead of upgrading. Relay it verbatim:
      // destroying the socket here erases the worker's answer, so every
      // refusal reaches the client as a bare connection reset, and a proxy in
      // front of Vite reports it as a generic "Network connection lost" 502.
      if (socket.destroyed) {
        response.resume();
        return;
      }

      // The socket was hijacked out of the HTTP server, so it carries no
      // framing of its own. `response` is already de-chunked by the client, so
      // hop-by-hop headers must not be copied; the body is close-delimited
      // instead.
      const statusLine = `HTTP/1.1 ${response.statusCode ?? 502} ${
        response.statusMessage ?? ""
      }`.trimEnd();
      const headerLines: Array<string> = [statusLine];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i]!;
        if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
        headerLines.push(`${name}: ${response.rawHeaders[i + 1]}`);
      }
      headerLines.push("connection: close");
      socket.write(`${headerLines.join("\r\n")}\r\n\r\n`);

      response.pipe(socket);
    });

    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      upstreamSocket.on("error", () => upstreamSocket.destroy());

      if (socket.destroyed) {
        upstreamSocket.destroy();
        return;
      }

      track(socket);
      track(upstreamSocket);

      const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${
        upstreamRes.statusMessage ?? "Switching Protocols"
      }`;
      const headerLines: Array<string> = [statusLine];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        headerLines.push(
          `${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`,
        );
      }
      socket.write(`${headerLines.join("\r\n")}\r\n\r\n`);

      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }

      socket.pipe(upstreamSocket).pipe(socket);
    });

    // WebSocket upgrade requests carry no body, and any early client bytes are
    // forwarded above via `upstreamSocket.write(head)`. Ending the request
    // directly flushes the upstream handshake deterministically, rather than
    // relying on the incoming `request` stream to emit `end` (which can be
    // delayed by TCP timing) and avoids a second consumer of the client socket.
    upstream.end();
  };

  httpServer.on("upgrade", onUpgrade);
  return () => {
    httpServer.off("upgrade", onUpgrade);
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  };
}

/**
 * Headers that describe one hop's connection rather than the message. Copying
 * `transfer-encoding: chunked` onto an already de-chunked body would corrupt
 * the relayed response, so the whole hop-by-hop set is dropped.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Matches the origin of a Sandbox SDK preview URL.
 * See: https://developers.cloudflare.com/sandbox/concepts/preview-urls/
 *
 * Pattern: https?://<port(4+ digits)>-<id(no dots)>-<token>.localhost
 *
 * IMPORTANT: The token segment is [a-z0-9_]+ (no hyphens) to prevent ReDoS — two adjacent
 * [^.]+ groups separated by - cause quadratic backtracking on hyphen-heavy input. Tokens
 * are documented as letters/digits/underscores only.
 */
const SANDBOX_ORIGIN_REGEXP =
  /^https?:\/\/\d{4,}-[^.]+-[a-z0-9_]+\.localhost(:\d+)?$/i;

function hasSandboxOrigin(origin: string) {
  return SANDBOX_ORIGIN_REGEXP.test(origin);
}
