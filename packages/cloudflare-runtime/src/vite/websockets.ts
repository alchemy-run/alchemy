import type { IncomingMessage } from "node:http";
import * as NodeNet from "node:net";
import type { Duplex } from "node:stream";
import type * as vite from "vite";
import { resolveForwardedHost } from "./forwarded-host.ts";

/**
 * Handles 'upgrade' requests on the Vite HTTP server and forwards the
 * WebSocket handshake to the local workerd address as a raw HTTP upgrade.
 *
 * The upstream half is a RAW TCP relay (`node:net`), not an
 * `http.request`: Node's http client surfaces a 101 as an `upgrade`
 * event with the hijacked socket, but Bun's `node:http` shim delivers
 * it as a plain `response` and never releases the socket — under Bun
 * an http-client relay silently kills every proxied WebSocket. The
 * upstream is always local workerd over plain HTTP, so writing the
 * handshake bytes ourselves and splicing the sockets is both simpler
 * and runtime-agnostic.
 *
 * Returns a cleanup function that removes the listener (used on server restart).
 */
export function handleWebSocket(
  httpServer: vite.HttpServer,
  address: string | URL,
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
    const upstream = NodeNet.connect({
      host: target.hostname,
      port: Number(target.port || 80),
    });

    const cleanup = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", cleanup);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());

    upstream.on("connect", () => {
      // Relay the client's handshake verbatim (`rawHeaders` preserves
      // casing and duplicates), rewriting only `Host` so the worker sees
      // the URL the client requested rather than the local workerd address.
      const lines = [
        `${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${url.host}`,
      ];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        if (request.rawHeaders[i]!.toLowerCase() === "host") continue;
        lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) {
        upstream.write(head);
      }
    });

    // Accumulate the upstream response head; on 101, forward it and splice
    // the sockets. Any other status means the worker declined the upgrade.
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headEnd = buffered.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        // A response head larger than this is not a WebSocket handshake.
        if (buffered.length > 64 * 1024) cleanup();
        return;
      }
      upstream.off("data", onData);
      const statusLine = buffered.subarray(0, buffered.indexOf("\r\n"));
      const status = Number(
        /^HTTP\/1\.[01] (\d{3})/.exec(String(statusLine))?.[1],
      );
      if (status !== 101 || socket.destroyed) {
        cleanup();
        return;
      }
      track(socket);
      track(upstream);
      // The head (and any WebSocket frames the worker already sent) go to
      // the client verbatim; from here on it's a byte pipe both ways.
      socket.write(buffered);
      socket.pipe(upstream).pipe(socket);
    };
    upstream.on("data", onData);
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
const SANDBOX_ORIGIN_REGEXP =
  /^https?:\/\/\d{4,}-[^.]+-[a-z0-9_]+\.localhost(:\d+)?$/i;

function hasSandboxOrigin(origin: string) {
  return SANDBOX_ORIGIN_REGEXP.test(origin);
}
