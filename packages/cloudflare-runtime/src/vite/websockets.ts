import type { IncomingMessage } from "node:http";
import * as NodeNet from "node:net";
import type { Duplex } from "node:stream";
import type * as vite from "vite";
import { proxyRequestHeaders, resolveForwardedHost } from "./forwarded-host.ts";
import { workerRequestUrl } from "./worker-request.ts";

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

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Unhandled socket errors crash Node.
    socket.on("error", () => socket.destroy());

    // The URL — and thus the Sandbox-origin check below — is built from the
    // resolved (forwarded) host, not the raw `Host` header. This diverges from
    // upstream, which keys the origin off `Host`; here it's intentional so a
    // tunnel-fronted Sandbox preview still matches. Direct Sandbox hits carry no
    // `X-Forwarded-Host`, so they fall back to `Host` and behave identically.
    const rawHost = resolveForwardedHost(request.headers, "localhost");
    const base = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
    const url = workerRequestUrl(request.url, base);

    const isViteRequest = request.headers["sec-websocket-protocol"]?.startsWith("vite") ?? false;
    const isSandboxRequest = hasSandboxOrigin(url.origin);

    // Vite handles its own HMR upgrades; forward Sandbox preview URLs anyway.
    if (isViteRequest && !isSandboxRequest) {
      return;
    }

    const target = new URL(url.pathname + url.search, upstreamBase);
    // A raw TCP tunnel rather than a `node:http` client request: Bun's
    // `node:http` client never emits `upgrade`, so the handshake would hang
    // there. Writing the request head and piping both ways relays the
    // Worker's answer byte for byte, whether a 101 or a refusal (a 403, a
    // 404, ...) that must reach the client rather than a connection reset.
    const upstream = NodeNet.connect({ host: target.hostname, port: Number(target.port) });
    track(socket);
    track(upstream);
    upstream.on("error", () => {
      upstream.destroy();
      socket.destroy();
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    upstream.once("connect", () => {
      if (socket.destroyed) {
        upstream.destroy();
        return;
      }
      const lines = [`${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`];
      for (const [name, value] of Object.entries(
        proxyRequestHeaders(request, url, proxySharedSecret),
      )) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${item}`);
        }
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) {
        upstream.write(head);
      }
      // oxlint-disable-next-line effecttsgo/unnecessary-pipe-chain -- Node stream piping (socket -> upstream -> socket), not Effect pipe
      socket.pipe(upstream).pipe(socket);
    });
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
 * Matches the origin of a Sandbox SDK preview URL.
 * See: https://developers.cloudflare.com/sandbox/concepts/preview-urls/
 *
 * Pattern: https?://<port(4+ digits)>-<id(no dots)>-<token>.localhost
 *
 * IMPORTANT: The token segment is [a-z0-9_]+ (no hyphens) to prevent ReDoS — two adjacent
 * [^.]+ groups separated by - cause quadratic backtracking on hyphen-heavy input. Tokens
 * are documented as letters/digits/underscores only.
 */
export const SANDBOX_ORIGIN_REGEXP = /^https?:\/\/\d{4,}-[^.]+-[a-z0-9_]+\.localhost(:\d+)?$/i;

function hasSandboxOrigin(origin: string) {
  return SANDBOX_ORIGIN_REGEXP.test(origin);
}
