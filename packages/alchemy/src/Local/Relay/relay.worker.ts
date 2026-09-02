/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import {
  AUTH_HEADER,
  CHUNK_SIZE,
  CONNECT_PATH,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  forwardableHeaders,
  NAMESPACE_PARAM,
  parsePublicHost,
  type ControlFrame,
  type HelloFrame,
  type RequestFrame,
} from "./RelayProtocol.ts";

/**
 * The Alchemy dev relay: a public front door for `alchemy dev` sessions.
 *
 * - The dev sidecar dials `wss://<domain>/__relay/connect?namespace=<ns>` once
 *   and keeps the socket open; the {@link RelaySession} Durable Object named
 *   `<ns>` holds it (hibernating while idle).
 * - Every request for `https://<label>.<ns>.<domain>` is routed by `Host` to
 *   that Durable Object and forwarded down the socket as a multiplexed
 *   stream; the connector answers it from the local ingress.
 *
 * Deployed with Alchemy itself (see `Relay.ts`); one Worker, one wildcard
 * route, no per-user infrastructure.
 */
interface Env {
  SESSIONS: DurableObjectNamespace<RelaySession>;
  /** Public domain: hosts are `<label>.<namespace>.<RELAY_DOMAIN>`. */
  RELAY_DOMAIN: string;
  /** Public scheme announced to connectors (`https`; `http` on TLS-less relays). */
  RELAY_SCHEME?: string;
  /** Shared bearer token connectors must present. Empty disables auth (dev relays only). */
  RELAY_TOKEN?: string;
}

const RESPONSE_TIMEOUT_MS = 30_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? url.host;
    const domain = env.RELAY_DOMAIN.toLowerCase();

    if (
      host.split(":")[0]!.toLowerCase() === domain &&
      url.pathname === CONNECT_PATH
    ) {
      return connect(request, url, env);
    }

    const target = parsePublicHost(host, domain);
    if (target === undefined) {
      return page(
        404,
        "Unknown host",
        `Nothing is served at <code>${escape(host)}</code>.`,
      );
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return page(
        501,
        "WebSockets are not relayed yet",
        "The dev relay forwards HTTP requests; WebSocket passthrough is on its way.",
      );
    }
    const headers = new Headers(request.headers);
    headers.set("x-relay-label", target.label);
    headers.set("x-relay-host", host);
    return env.SESSIONS.get(env.SESSIONS.idFromName(target.namespace)).fetch(
      new Request(request, { headers }),
    );
  },
};

const connect = (request: Request, url: URL, env: Env): Promise<Response> => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Promise.resolve(
      page(426, "Upgrade required", "Connect with a WebSocket client."),
    );
  }
  const token = request.headers.get(AUTH_HEADER)?.replace(/^Bearer\s+/i, "");
  if (env.RELAY_TOKEN && (!token || !timingSafeEqual(token, env.RELAY_TOKEN))) {
    return Promise.resolve(new Response("unauthorized", { status: 401 }));
  }
  const namespace = url.searchParams.get(NAMESPACE_PARAM)?.toLowerCase();
  if (!namespace || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) {
    return Promise.resolve(
      new Response("invalid or missing namespace", { status: 400 }),
    );
  }
  return env.SESSIONS.get(env.SESSIONS.idFromName(namespace)).fetch(request);
};

interface Pending {
  readonly resolveHead: (response: Response) => void;
  readonly rejectHead: (error: Error) => void;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
  headTimer?: ReturnType<typeof setTimeout>;
}

/**
 * One namespace's session: at most one live connector socket, and the table
 * of in-flight public requests keyed by stream id.
 */
export class RelaySession extends DurableObject<Env> {
  private pending = new Map<number, Pending>();
  private nextId = 1;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === CONNECT_PATH) {
      return this.accept(request, url);
    }
    return this.relay(request);
  }

  private accept(request: Request, url: URL): Response {
    const namespace = url.searchParams.get(NAMESPACE_PARAM) ?? "";
    // A new connector replaces the previous one (a restarted dev session).
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(4000, "replaced by a newer connector");
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const hello: HelloFrame = {
      t: "hello",
      namespace,
      domain: this.env.RELAY_DOMAIN,
      scheme: this.env.RELAY_SCHEME ?? "https",
    };
    server.send(encodeControl(hello));
    return new Response(null, { status: 101, webSocket: client });
  }

  private socket(): WebSocket | undefined {
    return this.ctx.getWebSockets()[0];
  }

  private async relay(request: Request): Promise<Response> {
    const socket = this.socket();
    const host = request.headers.get("x-relay-host") ?? "";
    if (socket === undefined) {
      return page(
        502,
        "alchemy dev is not connected",
        `No dev session is connected for <code>${escape(host)}</code>. Start <code>alchemy dev</code> with the relay enabled and retry.`,
      );
    }
    const id = this.nextId++;
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    const label = headers.get("x-relay-label") ?? "";
    headers.delete("x-relay-label");
    headers.delete("x-relay-host");
    headers.set("x-forwarded-host", host);
    headers.set("x-forwarded-proto", this.env.RELAY_SCHEME ?? "https");
    const hasBody = request.body !== null;
    const frame: RequestFrame = {
      t: "req",
      id,
      method: request.method,
      url: `${url.pathname}${url.search}`,
      host,
      label,
      headers: forwardableHeaders(headers),
      body: hasBody,
    };

    const head = new Promise<Response>((resolveHead, rejectHead) => {
      const entry: Pending = { resolveHead, rejectHead };
      entry.headTimer = setTimeout(() => {
        this.pending.delete(id);
        rejectHead(new Error("timed out waiting for the dev session"));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, entry);
    });

    socket.send(encodeControl(frame));
    if (hasBody) {
      // Pump the request body down the socket in bounded chunks.
      void this.pumpBody(socket, id, request.body!);
    }

    try {
      return await head;
    } catch (error) {
      return page(
        504,
        "No response from alchemy dev",
        escape(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async pumpBody(
    socket: WebSocket,
    id: number,
    body: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength; offset += CHUNK_SIZE) {
          socket.send(
            encodeChunk(id, value.subarray(offset, offset + CHUNK_SIZE)),
          );
        }
      }
      socket.send(encodeControl({ t: "end", id }));
    } catch (error) {
      socket.send(
        encodeControl({
          t: "abort",
          id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  // ── connector → relay ────────────────────────────────────────────────

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string") {
      this.onControl(decodeControl(message));
      return;
    }
    const { id, chunk } = decodeChunk(message);
    const entry = this.pending.get(id);
    if (entry?.writer) {
      // Copy: the frame's buffer is reused by the runtime.
      await entry.writer.write(new Uint8Array(chunk)).catch(() => {});
    }
  }

  private onControl(frame: ControlFrame): void {
    switch (frame.t) {
      case "res": {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        clearTimeout(entry.headTimer);
        const headers = new Headers();
        for (const [name, value] of frame.headers) headers.append(name, value);
        if (!frame.body) {
          this.pending.delete(frame.id);
          entry.resolveHead(
            new Response(null, { status: frame.status, headers }),
          );
          return;
        }
        const { readable, writable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();
        entry.writer = writable.getWriter();
        entry.resolveHead(
          new Response(readable, { status: frame.status, headers }),
        );
        return;
      }
      case "end": {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        this.pending.delete(frame.id);
        void entry.writer?.close().catch(() => {});
        return;
      }
      case "abort": {
        const entry = this.pending.get(frame.id);
        if (!entry) return;
        this.pending.delete(frame.id);
        clearTimeout(entry.headTimer);
        const error = new Error(frame.message ?? "aborted by the dev session");
        if (entry.writer) void entry.writer.abort(error).catch(() => {});
        else entry.rejectHead(error);
        return;
      }
      case "hello":
      case "req":
        return;
    }
  }

  async webSocketClose(): Promise<void> {
    // Fail everything in flight; the connector will reconnect.
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.headTimer);
      const error = new Error("the dev session disconnected");
      if (entry.writer) void entry.writer.abort(error).catch(() => {});
      else entry.rejectHead(error);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose();
    try {
      ws.close(1011, "error");
    } catch {}
  }
}

const timingSafeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < x.byteLength; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
};

const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const page = (status: number, title: string, body: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;padding:3rem 1.5rem;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:#f6f6f7;color:#1c1c1e}main{max-width:40rem;margin:0 auto}h1{font-size:1.25rem;font-weight:600}code{font:.9em ui-monospace,Menlo,monospace}small{color:#6b6b70}@media(prefers-color-scheme:dark){body{background:#111113;color:#ececef}small{color:#8c8c93}}</style>
</head><body><main><h1>${title}</h1><p>${body}</p><p><small>alchemy dev relay · ${status}</small></p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
