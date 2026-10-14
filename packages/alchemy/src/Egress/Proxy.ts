import * as net from "node:net";
import * as tls from "node:tls";
/**
 * The in-sandbox egress proxy (DESIGN.md §8, "Anywhere else"). Tools in the
 * sandbox reach the network through `HTTPS_PROXY`; the proxy decides per
 * request whether it goes to an egress gateway or straight out:
 *
 * - `CONNECT host:port` for a host with routes: TLS is terminated with a leaf
 *   from the sandbox's {@link LocalCa}, the request's path picks the most
 *   specific route, and a matched request is sent to that route's gateway as
 *   `POST` with `Authorization: Macaroon <grant>` and
 *   `x-alchemy-target` / `x-alchemy-method` naming the original request. An
 *   unmatched path on a routed host is sent straight to the real host.
 * - `CONNECT` for any other host: a plain TCP tunnel, never decrypted.
 * - Absolute-form `http://` requests: forwarded directly.
 *
 * Bodies stream both ways (a large git push never sits in memory).
 *
 * A control endpoint (`PUT /routes`, bearer secret) replaces the route table
 * at run time; the next request sees the new table.
 *
 * The CA is replaceable too ({@link EgressProxy.useCa}): an AWS Lambda
 * MicroVM resumes from a build-time snapshot, so a CA minted at boot would be
 * shared by every MicroVM of the image. There the bootstrap starts the proxy
 * with no CA and installs one minted in the `/run` hook. Until a proxy has a
 * CA it decrypts nothing: a routed host is refused (fail closed).
 *
 * Effect has no primitive for raw `CONNECT` sockets or TLS termination, so
 * the proxy works on `node:net` / `node:tls` sockets, each acquired in the
 * caller's `Scope` and destroyed when it closes. It is deliberately
 * byte-level: only a request's head (request line + headers) is parsed and
 * rewritten; bodies and responses are spliced through untouched, framing
 * included, one request per upstream connection (`Connection: close`). Bun's
 * `node:http` cannot carry this: its `CONNECT` sockets drop bytes under
 * load, its client never emits `drain` (unbounded buffering), and it
 * supports neither `new tls.TLSSocket(socket, { isServer: true })` nor
 * server-side `SNICallback`. Plain `net`/`tls` sockets behave the same on
 * both runtimes, so TLS is terminated by a per-host loopback `tls` server
 * presenting that host's leaf, reached through an ordinary byte tunnel.
 */
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import { HttpServer } from "effect/http/HttpServer";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ScopedCache from "effect/ScopedCache";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { httpServer } from "../Util/PlatformServices.ts";
import type { CaError, LocalCa } from "./LocalCa.ts";
import { hasRoute, mostSpecific, Routes, type Route } from "./Route.ts";

export { trustEnv, writeTrustBundle } from "./Trust.ts";

/** The proxy (or one of its loopback TLS servers) failed to listen. */
export class EgressProxyError extends Data.TaggedError("EgressProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const DEFAULT_PROXY_PORT = 3128;
export const DEFAULT_CONTROL_PORT = 3129;

export interface EgressProxyOptions {
  /** @default 3128 (0 picks a free port) */
  readonly port?: number;
  /** @default "127.0.0.1" */
  readonly host?: string;
  /** The live route table; replaced by the control endpoint. */
  readonly routes: SubscriptionRef.SubscriptionRef<ReadonlyArray<Route>>;
  /**
   * Signs the leaves presented for routed hosts. Absent, routed hosts are
   * refused (`503`) until {@link EgressProxy.useCa} installs one.
   */
  readonly ca?: LocalCa;
}

export interface EgressProxy {
  /** The bound port. */
  readonly port: number;
  /** What `HTTPS_PROXY` / `HTTP_PROXY` should be set to. */
  readonly url: string;
  /**
   * Sign leaves with `ca` from now on. Every terminator built for the
   * previous CA is closed, so no new connection is served a leaf it signed
   * (connections already decrypted run to completion).
   */
  readonly useCa: (ca: LocalCa) => Effect.Effect<void>;
}

/** A request's head: what the proxy reads and rewrites. */
interface RequestHead {
  readonly method: string;
  readonly target: string;
  /** In arrival order, original casing. */
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
}

/** The longest request head accepted. */
const MAX_HEAD = 64 * 1024;

/** A client that sent no complete head in time is dropped. */
const HEAD_TIMEOUT = Duration.seconds(30);

/** After one side of a splice closes, how long the other has to finish. */
const LINGER = Duration.seconds(30);

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1), dropped when a head is rewritten.
 * `transfer-encoding` is not here: the body is spliced through with its
 * framing intact, so the header describing that framing must go with it.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
]);

const noop = () => {};

const isIp = (host: string) => net.isIP(host) !== 0;

const parseHead = (text: string): RequestHead | undefined => {
  const [requestLine, ...lines] = text.split("\r\n");
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine ?? "");
  if (!match) return undefined;
  const headers: Array<readonly [string, string]> = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return { method: match[1]!, target: match[2]!, headers };
};

const header = (head: RequestHead, name: string) =>
  head.headers.find(([key]) => key.toLowerCase() === name)?.[1];

/**
 * `head`'s end-to-end headers, minus `drop`, plus `set` (which also replaces
 * any header of the same name), always with `Connection: close`.
 */
const rewriteHeaders = (
  head: RequestHead,
  options: { readonly drop?: ReadonlyArray<string>; readonly set?: Record<string, string> } = {},
) => {
  const named = new Set(
    (header(head, "connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const set = Object.entries(options.set ?? {});
  const replaced = new Set([...(options.drop ?? []), ...set.map(([name]) => name.toLowerCase())]);
  const kept = head.headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !HOP_BY_HOP.has(lower) && !named.has(lower) && !replaced.has(lower);
  });
  return [...kept, ...set, ["Connection", "close"] as const];
};

const serializeHead = (
  requestLine: string,
  headers: ReadonlyArray<readonly [string, string]>,
): Buffer =>
  Buffer.from(
    `${requestLine}\r\n${headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`,
    "latin1",
  );

/**
 * Read `socket` up to the end of a request head. Returns the head and any
 * bytes after it; leaves the socket paused, so nothing is lost before the
 * caller splices it. `undefined` for a malformed, oversized or abandoned head.
 */
const readHead = (socket: net.Socket) =>
  Effect.callback<{ head: RequestHead; rest: Buffer } | undefined>((resume) => {
    let buffered = Buffer.alloc(0);
    const finish = (result: { head: RequestHead; rest: Buffer } | undefined) => {
      socket.pause();
      socket.off("data", onData);
      socket.off("close", onClose);
      resume(Effect.succeed(result));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > MAX_HEAD) finish(undefined);
        return;
      }
      const head = parseHead(buffered.subarray(0, end).toString("latin1"));
      finish(head && { head, rest: buffered.subarray(end + 4) });
    };
    const onClose = () => finish(undefined);
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.resume();
  }).pipe(
    Effect.timeoutOrElse({ duration: HEAD_TIMEOUT, orElse: () => Effect.succeed(undefined) }),
  );

/** Resolves when the socket has closed (immediately if it already has). */
const awaitClose = (socket: net.Socket) =>
  Effect.callback<void>((resume) => {
    if (socket.destroyed) return resume(Effect.void);
    socket.once("close", () => resume(Effect.void));
  });

/** A socket that is destroyed when the scope closes. */
const own = <S extends net.Socket>(socket: S) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      socket.on("error", noop); // a reset surfaces as `close`
      return socket;
    }),
    (owned) => Effect.sync(() => owned.destroy()),
  );

/**
 * A connection to `host:port` (TLS when `tls` names the server, verified
 * against the system roots), destroyed when the scope closes.
 */
const connect = (host: string, port: number, secure?: { readonly servername: string }) =>
  Effect.acquireRelease(
    Effect.callback<net.Socket, EgressProxyError>((resume) => {
      const socket = secure
        ? tls.connect({
            host,
            port,
            servername: isIp(secure.servername) ? undefined : secure.servername,
            ALPNProtocols: ["http/1.1"],
          })
        : net.connect(port, host);
      const onError = (cause: Error) => {
        socket.destroy();
        resume(Effect.fail(new EgressProxyError({ message: `connect ${host}:${port}`, cause })));
      };
      socket.once("error", onError);
      socket.once(secure ? "secureConnect" : "connect", () => {
        socket.off("error", onError);
        socket.on("error", noop);
        resume(Effect.succeed(socket));
      });
      return Effect.sync(() => socket.destroy());
    }),
    (socket) => Effect.sync(() => socket.destroy()),
    { interruptible: true },
  );

/** Listen `server` on `host:port` in the current scope; the bound port. */
const listen = (server: net.Server, port: number, host: string) =>
  Effect.acquireRelease(
    Effect.callback<number, EgressProxyError>((resume) => {
      const onError = (cause: Error) =>
        resume(Effect.fail(new EgressProxyError({ message: `listen ${host}:${port}`, cause })));
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        server.on("error", noop);
        resume(Effect.succeed((server.address() as net.AddressInfo).port));
      });
    }),
    // Stop accepting; open connections are owned (and destroyed) by their
    // handler fibers.
    () => Effect.sync(() => server.close()),
  );

/**
 * Splice `a` and `b` until both close: bytes flow both ways with
 * backpressure, and an end on one side ends the other. Once one side has
 * closed, the other gets {@link LINGER} to flush before the scope destroys it.
 */
const splice = (a: net.Socket, b: net.Socket) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      a.pipe(b);
      b.pipe(a);
    });
    yield* Effect.raceFirst(awaitClose(a), awaitClose(b));
    yield* Effect.all([awaitClose(a), awaitClose(b)]).pipe(Effect.timeout(LINGER), Effect.ignore);
  });

const respond = (socket: net.Socket, status: string) =>
  Effect.sync(() => {
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });

/** `host:port` → parts. IPv6 literals arrive bracketed (`[::1]:443`). */
const parseAuthority = (authority: string, defaultPort: number) => {
  const match =
    /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) ?? /^([^:[\]]+)(?::(\d+))?$/.exec(authority);
  if (!match) return undefined;
  return { host: match[1]!, port: match[2] ? Number(match[2]) : defaultPort };
};

const formatAuthority = (host: string, port: number, defaultPort: number) => {
  const name = host.includes(":") ? `[${host}]` : host;
  return port === defaultPort ? name : `${name}:${port}`;
};

/**
 * Serve the egress proxy on `host:port` (default `127.0.0.1:3128`) until the
 * scope closes. Closing the scope closes the listener, every loopback TLS
 * server, and every open connection.
 */
export const serveEgressProxy = (
  options: EgressProxyOptions,
): Effect.Effect<EgressProxy, EgressProxyError, Scope.Scope> =>
  Effect.gen(function* () {
    const { routes } = options;
    // The CA in use, and a generation that names it: terminators are cached
    // per generation, so one built for a replaced CA is never handed out.
    const current = yield* Ref.make<{ readonly generation: number; readonly ca?: LocalCa }>({
      generation: 0,
      ca: options.ca,
    });
    const bind = options.host ?? "127.0.0.1";
    // Every connection handler runs in this set: closing the scope interrupts
    // them, and their finalizers destroy their sockets.
    const run = yield* FiberSet.makeRuntime<never>();

    /** A decrypted connection to a routed `host:port`: one request. */
    const handleDecrypted = (host: string, port: number, client: tls.TLSSocket) =>
      Effect.gen(function* () {
        yield* own(client);
        const request = yield* readHead(client);
        if (!request) return yield* respond(client, "400 Bad Request");
        const { head, rest } = request;
        const table = yield* SubscriptionRef.get(routes);
        const route = mostSpecific(table, host, head.target);
        const authority = formatAuthority(host, port, 443);

        let upstream: net.Socket;
        if (route) {
          const gateway = URL.canParse(route.gateway.url) ? new URL(route.gateway.url) : undefined;
          if (!gateway || (gateway.protocol !== "https:" && gateway.protocol !== "http:")) {
            return yield* respond(client, "502 Bad Gateway");
          }
          const secure = gateway.protocol === "https:";
          const connected = yield* connect(
            gateway.hostname.replace(/^\[|\]$/g, ""),
            Number(gateway.port) || (secure ? 443 : 80),
            secure ? { servername: gateway.hostname } : undefined,
          ).pipe(Effect.option);
          if (connected._tag === "None") return yield* respond(client, "502 Bad Gateway");
          upstream = connected.value;
          upstream.write(
            serializeHead(
              `POST ${gateway.pathname}${gateway.search} HTTP/1.1`,
              rewriteHeaders(head, {
                // The placeholder credential stays here.
                drop: ["authorization"],
                set: {
                  Host: gateway.host,
                  Authorization: `Macaroon ${route.grant}`,
                  "x-alchemy-target": `https://${authority}${head.target}`,
                  "x-alchemy-method": head.method,
                },
              }),
            ),
          );
        } else {
          // A routed host, but not this path: straight out, untouched.
          const connected = yield* connect(host, port, { servername: host }).pipe(Effect.option);
          if (connected._tag === "None") return yield* respond(client, "502 Bad Gateway");
          upstream = connected.value;
          upstream.write(
            serializeHead(`${head.method} ${head.target} HTTP/1.1`, rewriteHeaders(head)),
          );
        }
        if (rest.length > 0) upstream.write(rest);
        yield* splice(client, upstream);
      }).pipe(Effect.scoped);

    // One loopback TLS server per CA generation and routed `host:port`,
    // presenting that host's leaf. Re-created after 12h so the leaf (24h)
    // never expires in use; a failed start is not cached.
    // Keyed `<generation> <host:port>`.
    const terminators = yield* ScopedCache.makeWith<string, number, EgressProxyError | CaError>({
      capacity: 1024,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.hours(12) : Duration.zero),
      lookup: (key) =>
        Effect.gen(function* () {
          const space = key.indexOf(" ");
          const generation = Number(key.slice(0, space));
          const { host, port } = parseAuthority(key.slice(space + 1), 443)!;
          const { generation: now, ca } = yield* Ref.get(current);
          // Replaced (or never installed) since the caller looked: refuse
          // rather than cache a leaf from the wrong CA.
          if (!ca || now !== generation) {
            return yield* new EgressProxyError({ message: `no CA for ${host}` });
          }
          const leaf = yield* ca.leafFor(host);
          const server = tls.createServer(
            // http/1.1 only: the proxy rewrites HTTP/1 heads, not h2 frames.
            { cert: leaf.cert, key: leaf.key, ALPNProtocols: ["http/1.1"] },
            (socket) => run(handleDecrypted(host, port, socket)),
          );
          server.on("tlsClientError", noop);
          return yield* listen(server, 0, "127.0.0.1");
        }),
    });

    /** `CONNECT host:port`: decrypt a routed host, tunnel anything else. */
    const handleConnect = (client: net.Socket, authority: string, rest: Buffer) =>
      Effect.gen(function* () {
        const target = parseAuthority(authority, 443);
        if (!target) return yield* respond(client, "400 Bad Request");
        const table = yield* SubscriptionRef.get(routes);
        const routed = hasRoute(table, target.host);
        const { generation, ca } = yield* Ref.get(current);
        // No CA yet: nothing is decrypted, and a routed host never goes out
        // without its gateway.
        if (routed && !ca) return yield* respond(client, "503 Service Unavailable");
        const upstream = yield* (
          routed
            ? // Decrypt: the path decides the route, so it must be visible.
              ScopedCache.get(
                terminators,
                `${generation} ${formatAuthority(target.host, target.port, -1)}`,
              ).pipe(Effect.flatMap((port) => connect("127.0.0.1", port)))
            : // npm, PyPI, docs: tunnelled untouched.
              connect(target.host, target.port)
        ).pipe(Effect.option);
        if (upstream._tag === "None") return yield* respond(client, "502 Bad Gateway");
        yield* Effect.sync(() => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length > 0) upstream.value.write(rest);
        });
        yield* splice(client, upstream.value);
      });

    /** Absolute-form `GET http://host/path`: forwarded directly. */
    const handlePlain = (client: net.Socket, head: RequestHead, rest: Buffer) =>
      Effect.gen(function* () {
        const url = URL.canParse(head.target) ? new URL(head.target) : undefined;
        if (!url || url.protocol !== "http:") return yield* respond(client, "400 Bad Request");
        const upstream = yield* connect(
          url.hostname.replace(/^\[|\]$/g, ""),
          Number(url.port) || 80,
        ).pipe(Effect.option);
        if (upstream._tag === "None") return yield* respond(client, "502 Bad Gateway");
        yield* Effect.sync(() => {
          upstream.value.write(
            serializeHead(
              `${head.method} ${url.pathname}${url.search} HTTP/1.1`,
              rewriteHeaders(head, { set: { Host: url.host } }),
            ),
          );
          if (rest.length > 0) upstream.value.write(rest);
        });
        yield* splice(client, upstream.value);
      });

    const handleClient = (socket: net.Socket) =>
      Effect.gen(function* () {
        const client = yield* own(socket);
        const request = yield* readHead(client);
        if (!request) return yield* respond(client, "400 Bad Request");
        return yield* request.head.method === "CONNECT"
          ? handleConnect(client, request.head.target, request.rest)
          : handlePlain(client, request.head, request.rest);
      }).pipe(Effect.scoped);

    const server = net.createServer((socket) => run(handleClient(socket)));
    const port = yield* listen(server, options.port ?? DEFAULT_PROXY_PORT, bind);
    const display = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
    const useCa = (ca: LocalCa) =>
      Ref.update(current, ({ generation }) => ({ generation: generation + 1, ca })).pipe(
        Effect.andThen(ScopedCache.invalidateAll(terminators)),
      );
    return { port, url: `http://${display}:${port}`, useCa } satisfies EgressProxy;
  });

export interface EgressControlOptions {
  /** @default 3129 (0 picks a free port) */
  readonly port?: number;
  /** `0.0.0.0` in a sandbox (the owner pushes from outside); `127.0.0.1` in tests. */
  readonly host?: string;
  /** The table `PUT /routes` replaces. */
  readonly routes: SubscriptionRef.SubscriptionRef<ReadonlyArray<Route>>;
  /**
   * Callers must send `Authorization: Bearer <secret>`. Absent, `PUT /routes`
   * answers 401 until a {@link EgressControlHooks.run} hook delivers one.
   */
  readonly secret?: Redacted.Redacted<string>;
  /**
   * Also answer an AWS Lambda MicroVM image's lifecycle hooks on this port
   * (`hooks.port`): a MicroVM resumes from a snapshot taken at build time,
   * so its per-run configuration (the control secret, the first route table,
   * the program's environment) arrives in the `/run` hook's payload.
   */
  readonly hooks?: EgressControlHooks;
}

/** The MicroVM lifecycle hooks the control endpoint answers (`/aws/lambda-microvms/runtime/v1/*`). */
export interface EgressControlHooks {
  /** `/ready` during the image build: 200 when ready to snapshot, else 503 (retried). */
  readonly ready?: Effect.Effect<boolean>;
  /**
   * `/run`, once per MicroVM, before it takes traffic: `payload` is the
   * `runHookPayload` given to `RunMicrovm`. Returns the control secret.
   * Only the first call is accepted (Lambda's own, which precedes any
   * traffic); later ones are refused.
   */
  readonly run: (
    payload: string | undefined,
  ) => Effect.Effect<Redacted.Redacted<string>, EgressProxyError>;
}

/** Where AWS Lambda MicroVMs call lifecycle hooks. */
export const MICROVM_HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1/";

const decodeRoutes = Schema.decodeUnknownEffect(Routes);

/** Constant-time string equality (length leaks; contents don't). */
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Serve the route-table control endpoint until the scope closes:
 * `PUT /routes` with `Authorization: Bearer <secret>` and a JSON route table
 * replaces the table (204); a wrong or missing secret is 401.
 */
export const serveEgressControl = (
  options: EgressControlOptions,
): Effect.Effect<{ readonly port: number }, EgressProxyError, Scope.Scope> =>
  Effect.gen(function* () {
    const context: Context.Context<HttpServer> = yield* Layer.build(
      httpServer(options.port ?? DEFAULT_CONTROL_PORT, options.host ?? "127.0.0.1", {
        gracefulShutdownTimeout: 0,
      }),
    ).pipe(
      Effect.mapError(
        (cause) => new EgressProxyError({ message: "egress control failed to listen", cause }),
      ),
    );
    const server = yield* HttpServer.pipe(Effect.provideContext(context));
    let expected = options.secret ? `Bearer ${Redacted.value(options.secret)}` : undefined;
    let ran = false;
    const hooks = options.hooks;

    const answerHook = (name: string, request: HttpServerRequest) =>
      Effect.gen(function* () {
        if (!hooks || request.method !== "POST") return HttpServerResponse.empty({ status: 404 });
        if (name === "ready") {
          const ready = hooks.ready ? yield* hooks.ready : true;
          return HttpServerResponse.empty({ status: ready ? 200 : 503 });
        }
        if (name === "run") {
          if (ran) return HttpServerResponse.empty({ status: 409 });
          ran = true;
          const body = yield* request.json.pipe(Effect.option);
          const payload =
            body._tag === "Some" &&
            typeof body.value === "object" &&
            body.value !== null &&
            typeof (body.value as { runHookPayload?: unknown }).runHookPayload === "string"
              ? (body.value as { runHookPayload: string }).runHookPayload
              : undefined;
          const secret = yield* Effect.result(hooks.run(payload));
          if (secret._tag === "Failure") {
            yield* Effect.logError("the MicroVM run hook failed", secret.failure);
            return HttpServerResponse.text(secret.failure.message, { status: 500 });
          }
          expected = `Bearer ${Redacted.value(secret.success)}`;
          return HttpServerResponse.empty({ status: 200 });
        }
        // resume, suspend, terminate: nothing to do.
        return HttpServerResponse.empty({ status: 200 });
      });

    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = request.url.split("?")[0]!;
        if (path.startsWith(MICROVM_HOOK_PREFIX)) {
          return yield* answerHook(path.slice(MICROVM_HOOK_PREFIX.length), request);
        }
        if (expected === undefined || !safeEqual(request.headers.authorization ?? "", expected)) {
          return HttpServerResponse.empty({ status: 401 });
        }
        if (request.method !== "PUT" || request.url.split("?")[0] !== "/routes") {
          return HttpServerResponse.empty({ status: 404 });
        }
        const table = yield* request.json.pipe(Effect.flatMap(decodeRoutes), Effect.option);
        if (table._tag === "None") {
          return HttpServerResponse.text("expected a JSON route table", { status: 400 });
        }
        yield* SubscriptionRef.set(options.routes, table.value);
        return HttpServerResponse.empty({ status: 204 });
      }),
    );
    const address = server.address;
    return { port: "port" in address ? address.port : 0 };
  });
