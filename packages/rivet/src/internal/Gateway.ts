/**
 * Requests to an actor through the control plane's gateway, the way
 * RivetKit's client sends them, over the runtime's own `fetch` — so callers
 * (Workers, Lambdas, containers) need no RivetKit.
 *
 * @internal
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import type { NativeFetcher } from "./Fetcher.ts";

export interface GatewayTarget {
  /** The control plane URL the caller reaches. */
  readonly endpoint: string;
  readonly token: string;
  readonly namespace: string;
  /** The pool that hosts the actor, so the gateway can create it there. */
  readonly pool: string;
  /** The actor name: the Durable Object's logical id. */
  readonly name: string;
  /** The instance key. */
  readonly key: string;
}

/** The header the gateway reads the caller's token from, as RivetKit's client sends it. */
export const TOKEN_HEADER = "x-rivet-token";

/** RivetKit's canonical key encoding (one part). */
const encodeKey = (key: string) =>
  key === "" ? "\\0" : key.replace(/\\/g, "\\\\").replace(/,/g, "\\,");

/**
 * The gateway URL for a request to `/path?query` on an actor addressed by
 * name and key, created in its pool on first use. The token travels in the
 * {@link TOKEN_HEADER} header, never the URL, so it stays out of proxy and
 * load balancer logs.
 */
export const gatewayUrl = (
  target: GatewayTarget,
  path: string,
  search: string,
  route: "request" | "websocket" = "request",
): string => {
  const params = new URLSearchParams({
    "rvt-namespace": target.namespace,
    "rvt-method": "getOrCreate",
    "rvt-runner": target.pool,
    "rvt-key": encodeKey(target.key),
    "rvt-crash-policy": "sleep",
  });
  const base = target.endpoint.replace(/\/+$/, "");
  const query = search === "" ? `?${params}` : `${search}&${params}`;
  return `${base}/gateway/${encodeURIComponent(target.name)}/${route}${path}${query}`;
};

/** Headers a WebSocket handshake sets itself, never forwarded. */
const HANDSHAKE_HEADERS = new Set([
  "connection",
  "upgrade",
  "host",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "sec-websocket-accept",
]);

/**
 * Copy frames from a socket's reader into a writer until the reader closes,
 * then close the writer with the reader's close code.
 */
const forward = (
  reader: Effect.Effect<Socket.Reader, Socket.SocketError, Scope.Scope>,
  to: Socket.Writer,
) =>
  Effect.gen(function* () {
    const { pull } = yield* reader;
    while (true) yield* to.writeAll(yield* pull);
  }).pipe(
    Effect.scoped,
    Effect.catchTag("SocketError", (error) =>
      to
        .write(
          error.reason._tag === "SocketCloseError"
            ? new Socket.CloseEvent(error.reason.code, error.reason.closeReason)
            : new Socket.CloseEvent(1011, "The WebSocket failed"),
        )
        .pipe(Effect.ignore),
    ),
  );

/** The gateway could not be reached to carry a WebSocket. */
class GatewayUnreachable extends Data.TaggedError("Rivet.GatewayUnreachable")<{
  readonly cause: unknown;
}> {}

/** In workerd, an upgrade `fetch` answers with the gateway's socket. */
const upgradeFetch = (url: string, headers: Record<string, string>) =>
  fetch(url, { headers: { ...headers, Upgrade: "websocket" } });

/**
 * Carry a WebSocket upgrade (the current request) to the actor through the
 * gateway. In a Worker, the gateway's socket is handed back as the
 * response. Elsewhere (a Bun or Node server) the socket to the actor opens
 * first, so a refusal is an HTTP error, then the caller's request upgrades
 * and frames are copied both ways until either side closes.
 */
export const gatewayUpgrade = (
  target: GatewayTarget,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://caller");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HANDSHAKE_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    headers[TOKEN_HEADER] = target.token;
    const socketUrl = gatewayUrl(target, url.pathname, url.search, "websocket");
    if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === "function") {
      // workerd: an upgrade `fetch` returns the gateway's socket.
      return yield* Effect.tryPromise({
        try: () => upgradeFetch(socketUrl, headers),
        catch: (cause) => new GatewayUnreachable({ cause }),
      }).pipe(
        Effect.map((response) => HttpServerResponse.raw(response, { status: response.status })),
        Effect.catchTag("Rivet.GatewayUnreachable", () =>
          Effect.succeed(
            HttpServerResponse.text("The Durable Object refused the WebSocket", { status: 502 }),
          ),
        ),
      );
    }
    const upstream = yield* Socket.makeWebSocket(socketUrl.replace(/^http/, "ws"), {
      headers,
      openTimeout: "30 seconds",
    }).pipe(
      Effect.provideService(
        Socket.WebSocketConstructor,
        (socketUrl, options) =>
          // Bun's and Node's WebSocket take handshake headers.
          new globalThis.WebSocket(socketUrl, options as never),
      ),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Open the actor's side first: a refusal answers the caller over HTTP.
        const reader = yield* upstream.reader.pipe(Effect.option);
        if (reader._tag === "None") {
          return HttpServerResponse.text("The Durable Object refused the WebSocket", {
            status: 502,
          });
        }
        const downstream = yield* request.upgrade;
        const toCaller = yield* downstream.writer;
        const toActor = yield* upstream.writer;
        yield* Effect.raceFirst(
          forward(Effect.succeed(reader.value), toCaller),
          forward(downstream.reader, toActor),
        );
        return HttpServerResponse.empty({ status: 101 });
      }),
    );
  });

/** A fetcher whose requests reach the actor's `onRequest` (and `onWebSocket`) through the gateway. */
export const gatewayFetcher = (target: GatewayTarget): NativeFetcher => ({
  upgrade: (request) => gatewayUpgrade(target, request),
  fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    headers.set(TOKEN_HEADER, target.token);
    return fetch(gatewayUrl(target, url.pathname, url.search), {
      method: request.method,
      headers,
      body: body === undefined || body.byteLength === 0 ? undefined : body,
      signal: request.signal,
    });
  },
});

/**
 * Send one request to the gateway over the runtime's own `fetch`, with the
 * caller's token in {@link TOKEN_HEADER}.
 */
export const gatewaySend = (
  url: string,
  token: string,
  init: {
    readonly method: string;
    readonly headers?: Record<string, string> | undefined;
    readonly body?: Uint8Array | undefined;
    readonly signal: AbortSignal;
  },
) =>
  fetch(url, {
    method: init.method,
    headers: { ...init.headers, [TOKEN_HEADER]: token },
    body: init.body as BodyInit | undefined,
    signal: init.signal,
  });
