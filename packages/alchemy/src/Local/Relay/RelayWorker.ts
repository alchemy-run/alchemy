import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Cloudflare from "../../Cloudflare/index.ts";
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
 * The Alchemy dev relay — a public front door for `alchemy dev` sessions.
 *
 * - The dev sidecar dials `wss://<domain>/__relay/connect?namespace=<ns>` once
 *   and keeps the socket open; the {@link RelaySession} Durable Object named
 *   `<ns>` holds it (hibernating while idle).
 * - Every request for `https://<label>.<ns>.<domain>` is routed by `Host` to
 *   that Durable Object and forwarded down the socket as a multiplexed
 *   stream (see `RelayProtocol.ts`); the connector answers it from the
 *   local ingress.
 *
 * Configured with `Config` at init — Alchemy captures the values as bindings
 * at deploy and re-resolves them at runtime:
 *
 * - `DEV_RELAY_DOMAIN` — public domain, hosts are `<label>.<ns>.<domain>`
 * - `DEV_RELAY_ZONE` — zone name the routes attach to
 * - `DEV_RELAY_SCHEME` — `https` (default) or `http` on a TLS-less relay
 * - `DEV_RELAY_TOKEN` — optional shared bearer token connectors must present
 *
 * Deploy it with Alchemy itself: see `Relay.ts` and `stacks/dev-relay.ts`.
 */

const domain = Config.string("DEV_RELAY_DOMAIN").pipe(
  Config.map((value) => value.toLowerCase()),
);
const scheme = Config.string("DEV_RELAY_SCHEME").pipe(
  Config.withDefault("https"),
);
const token = Config.option(Config.redacted("DEV_RELAY_TOKEN"));

/** How long a public request waits for the dev session's response head. */
const RESPONSE_TIMEOUT = "30 seconds";

interface Pending {
  readonly head: Deferred.Deferred<
    HttpServerResponse.HttpServerResponse,
    Error
  >;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

const page = (status: number, title: string, body: string) =>
  HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;padding:3rem 1.5rem;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:#f6f6f7;color:#1c1c1e}main{max-width:40rem;margin:0 auto}h1{font-size:1.25rem;font-weight:600}code{font:.9em ui-monospace,Menlo,monospace}small{color:#6b6b70}@media(prefers-color-scheme:dark){body{background:#111113;color:#ececef}small{color:#8c8c93}}</style>
</head><body><main><h1>${title}</h1><p>${body}</p><p><small>alchemy dev relay · ${status}</small></p></main></body></html>`,
    { status, contentType: "text/html; charset=utf-8" },
  );

const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * One namespace's session: at most one live connector socket, and the table
 * of in-flight public requests keyed by stream id.
 */
export class RelaySession extends Cloudflare.DurableObject<RelaySession>()(
  "RelaySession",
  Effect.gen(function* () {
    const relayDomain = yield* Effect.orDie(domain);
    const relayScheme = yield* Effect.orDie(scheme);

    return Effect.gen(function* () {
      const ctx = yield* Cloudflare.DurableObjectState;
      const pending = new Map<number, Pending>();
      let nextId = 1;

      const connectorSocket = Effect.map(ctx.getWebSockets(), (sockets) =>
        Option.fromNullishOr(sockets[0]),
      );

      /** Accept a connector: a new one replaces the previous (restarted) session. */
      const accept = Effect.fn(function* (namespace: string) {
        const previous = yield* ctx.getWebSockets();
        yield* Effect.forEach(previous, (socket) =>
          socket.close(4000, "replaced by a newer connector"),
        );
        const [response, socket] = yield* Cloudflare.upgrade();
        const hello: HelloFrame = {
          t: "hello",
          namespace,
          domain: relayDomain,
          scheme: relayScheme,
        };
        yield* socket.send(encodeControl(hello));
        return response;
      });

      /** Forward one public request down the socket and await its response. */
      const relay = Effect.fn(function* (
        request: HttpServerRequest.HttpServerRequest,
        socket: Cloudflare.WebSocket,
        host: string,
        label: string,
      ) {
        const id = nextId++;
        const url = new URL(request.url, "http://relay");
        const headers = Headers.setAll(request.headers, {
          "x-forwarded-host": host,
          "x-forwarded-proto": relayScheme,
        });
        const hasBody = request.method !== "GET" && request.method !== "HEAD";
        const frame: RequestFrame = {
          t: "req",
          id,
          method: request.method,
          url: `${url.pathname}${url.search}`,
          host,
          label,
          headers: forwardableHeaders(Object.entries(headers)),
          body: hasBody,
        };
        const head = yield* Deferred.make<
          HttpServerResponse.HttpServerResponse,
          Error
        >();
        pending.set(id, { head });
        yield* socket.send(encodeControl(frame));
        if (hasBody) {
          // Pump the body in bounded chunks; the response head can arrive
          // before the body finishes, so this runs detached from the request.
          yield* request.stream.pipe(
            Stream.flatMap((bytes) => {
              const chunks: Uint8Array[] = [];
              for (let o = 0; o < bytes.byteLength; o += CHUNK_SIZE) {
                chunks.push(bytes.subarray(o, o + CHUNK_SIZE));
              }
              return Stream.fromIterable(chunks);
            }),
            Stream.runForEach((chunk) => socket.send(encodeChunk(id, chunk))),
            Effect.andThen(socket.send(encodeControl({ t: "end", id }))),
            Effect.catch((error) =>
              socket.send(
                encodeControl({ t: "abort", id, message: String(error) }),
              ),
            ),
            Effect.forkDetach,
          );
        }
        return yield* Deferred.await(head).pipe(
          Effect.timeoutOrElse({
            duration: RESPONSE_TIMEOUT,
            orElse: () =>
              Effect.sync(() => {
                pending.delete(id);
                return page(
                  504,
                  "No response from alchemy dev",
                  "The dev session did not answer in time.",
                );
              }),
          }),
          Effect.catch((error) =>
            Effect.succeed(
              page(504, "No response from alchemy dev", escape(error.message)),
            ),
          ),
        );
      });

      const settle = (frame: ControlFrame) =>
        Effect.sync(() => {
          switch (frame.t) {
            case "res": {
              const entry = pending.get(frame.id);
              if (!entry) return;
              const headers = Headers.fromInput(frame.headers);
              if (!frame.body) {
                pending.delete(frame.id);
                Deferred.doneUnsafe(
                  entry.head,
                  Effect.succeed(
                    HttpServerResponse.empty({ status: frame.status, headers }),
                  ),
                );
                return;
              }
              const { readable, writable } = new TransformStream<
                Uint8Array,
                Uint8Array
              >();
              entry.writer = writable.getWriter();
              Deferred.doneUnsafe(
                entry.head,
                Effect.succeed(
                  HttpServerResponse.stream(
                    Stream.fromReadableStream({
                      evaluate: () => readable,
                      onError: (error) => error,
                    }),
                    { status: frame.status, headers },
                  ),
                ),
              );
              return;
            }
            case "end": {
              const entry = pending.get(frame.id);
              if (!entry) return;
              pending.delete(frame.id);
              void entry.writer?.close().catch(() => {});
              return;
            }
            case "abort": {
              const entry = pending.get(frame.id);
              if (!entry) return;
              pending.delete(frame.id);
              const error = new Error(
                frame.message ?? "aborted by the dev session",
              );
              if (entry.writer) void entry.writer.abort(error).catch(() => {});
              else Deferred.doneUnsafe(entry.head, Effect.fail(error));
              return;
            }
            case "hello":
            case "req":
              return;
          }
        });

      const failAll = (message: string) =>
        Effect.sync(() => {
          for (const [id, entry] of pending) {
            pending.delete(id);
            const error = new Error(message);
            if (entry.writer) void entry.writer.abort(error).catch(() => {});
            else Deferred.doneUnsafe(entry.head, Effect.fail(error));
          }
        });

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://relay");
          if (url.pathname === CONNECT_PATH) {
            return yield* accept(url.searchParams.get(NAMESPACE_PARAM) ?? "");
          }
          const host = request.headers["x-relay-host"] ?? "";
          const label = request.headers["x-relay-label"] ?? "";
          const socket = yield* connectorSocket;
          if (Option.isNone(socket)) {
            return page(
              502,
              "alchemy dev is not connected",
              `No dev session is connected for <code>${escape(host)}</code>. Start <code>alchemy dev</code> with the relay enabled and retry.`,
            );
          }
          return yield* relay(request, socket.value, host, label);
        }),
        webSocketMessage: (_socket, message) =>
          typeof message === "string"
            ? settle(decodeControl(message))
            : Effect.sync(() => {
                const { id, chunk } = decodeChunk(message);
                const entry = pending.get(id);
                // Copy: the frame's buffer is reused by the runtime.
                void entry?.writer
                  ?.write(new Uint8Array(chunk))
                  .catch(() => {});
              }),
        webSocketClose: () => failAll("the dev session disconnected"),
      };
    });
  }),
) {}

/**
 * The relay's front door: authenticates connectors on `/__relay/connect` and
 * routes every `<label>.<namespace>.<domain>` request to that namespace's
 * {@link RelaySession}.
 */
export default class DevRelayWorker extends Cloudflare.Worker<DevRelayWorker>()(
  "DevRelay",
  {
    main: import.meta.url,
    routes: [
      // The connect endpoint at the domain apex …
      {
        pattern: Config.map(domain, (d) => `${d}/*`),
        zoneName: Config.string("DEV_RELAY_ZONE"),
      },
      // … and every `<label>.<namespace>.<domain>` — the leading wildcard
      // matches across dots.
      {
        pattern: Config.map(domain, (d) => `*.${d}/*`),
        zoneName: Config.string("DEV_RELAY_ZONE"),
      },
    ],
  },
  Effect.gen(function* () {
    const sessions = yield* RelaySession;
    const relayDomain = yield* domain;
    const relayToken = yield* token;

    const authorized = (
      request: HttpServerRequest.HttpServerRequest,
    ): boolean => {
      if (Option.isNone(relayToken)) return true;
      const presented = request.headers[AUTH_HEADER]?.replace(
        /^Bearer\s+/i,
        "",
      );
      return (
        presented !== undefined &&
        timingSafeEqual(presented, Redacted.value(relayToken.value))
      );
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const host = request.headers.host ?? "";
        const hostname = host.split(":")[0]!.toLowerCase();
        const url = new URL(request.url, "http://relay");

        if (hostname === relayDomain && url.pathname === CONNECT_PATH) {
          if (request.headers.upgrade?.toLowerCase() !== "websocket") {
            return page(
              426,
              "Upgrade required",
              "Connect with a WebSocket client.",
            );
          }
          if (!authorized(request)) {
            return HttpServerResponse.text("unauthorized", { status: 401 });
          }
          const namespace = url.searchParams
            .get(NAMESPACE_PARAM)
            ?.toLowerCase();
          if (
            !namespace ||
            !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)
          ) {
            return HttpServerResponse.text("invalid or missing namespace", {
              status: 400,
            });
          }
          return yield* sessions.getByName(namespace).fetch(request);
        }

        const target = parsePublicHost(host, relayDomain);
        if (target === undefined) {
          return page(
            404,
            "Unknown host",
            `Nothing is served at <code>${escape(host)}</code>.`,
          );
        }
        if (request.headers.upgrade?.toLowerCase() === "websocket") {
          return page(
            501,
            "WebSockets are not relayed yet",
            "The dev relay forwards HTTP requests; WebSocket passthrough is on its way.",
          );
        }
        // Tag the request with its public host and label for the session.
        // Rebuilt from the raw Request so the extra headers survive the
        // stub hop whichever representation it forwards.
        const raw = request.source as Request;
        const tagged = new Request(raw, {
          headers: {
            ...Object.fromEntries(raw.headers),
            "x-relay-host": host,
            "x-relay-label": target.label,
          },
        });
        return yield* sessions
          .getByName(target.namespace)
          .fetch(HttpServerRequest.fromWeb(tagged));
      }),
    };
  }),
) {}

const timingSafeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < x.byteLength; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
};
