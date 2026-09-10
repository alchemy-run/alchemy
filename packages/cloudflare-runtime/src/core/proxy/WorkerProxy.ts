import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
import * as Port from "../internal/Port.ts";
import type { RuntimeError } from "../RuntimeError.shared.ts";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";

/**
 * A stable local address for a Worker whose runtime comes and goes.
 *
 * A dev Worker's workerd is replaced on every code change (make-before-break),
 * so its own port moves. The proxy owns the port the user sees and relays each
 * accepted connection to whatever upstream is currently {@link
 * WorkerProxyInstance.set}: a plain byte pipe over `node:net`, with no HTTP
 * parsing in between. HTTP/1.1, streaming bodies and WebSocket upgrades all
 * pass through untouched, and the Worker receives the client's real `Host`
 * header, so `request.url` inside it is the public URL.
 *
 * Deliberately NOT `node:http`: Bun's `node:http` shim (1.3.13) delivers an
 * upstream 101 as a plain `response` and loses writes on a server `upgrade`
 * socket, which kills every proxied WebSocket whenever the host process runs
 * on Bun. A byte pipe never enters that code path.
 *
 * Connections accepted while no upstream is set are parked until one is
 * set (a worker restart) or the client gives up; that is the queue that
 * covers the restart gap. Whatever the client sends before its upstream is
 * connected is held by the proxy itself and replayed first: Bun's
 * `net.Socket` (1.3.13) discards bytes that arrive before a `data` listener
 * exists, where Node buffers them, so the proxy never relies on the socket
 * to do the holding. Setting a different upstream destroys the connections
 * spliced to the previous one — with make-before-break the old runtime is
 * torn down right after, so an in-flight exchange there would be reset
 * anyway, and a keep-alive connection must not stay pinned to it.
 */
export class WorkerProxy extends Context.Service<
  WorkerProxy,
  {
    readonly serve: (
      options?: ServeOptions,
    ) => Effect.Effect<WorkerProxyInstance, RuntimeError, Scope.Scope>;
  }
>()("cloudflare-runtime/proxy/WorkerProxy") {}

export interface ServeOptions {
  /**
   * The port to serve the proxy on. If not provided, a random port will be chosen.
   * @default 0
   */
  readonly port?: number;
  /**
   * Whether to throw an error if the port is not available.
   * @default false
   */
  readonly strictPort?: boolean;
  /**
   * The host to serve the proxy on.
   * @default "localhost"
   */
  readonly host?: string;
  /**
   * How long a connection accepted while no upstream is set waits for one
   * before it is answered with a 502.
   * @default 120_000
   */
  readonly pendingTimeoutMs?: number;
}

/** Maximum number of port-collision retries for a single `serve` call. */
const MAX_SERVE_ATTEMPTS = 8;

const DEFAULT_PENDING_TIMEOUT_MS = 120_000;

/**
 * Bytes held for a client whose upstream is not connected yet, before the
 * proxy stops reading from it. A request head is a few KB; a body this
 * large arriving before the worker is up simply waits in the kernel.
 */
const HOLD_LIMIT_BYTES = 1024 * 1024;

export interface WorkerProxyInstance {
  readonly proxySharedSecret: string;
  readonly url: URL;
  /** Route new connections to `upstream` (plain HTTP); release parked ones. */
  readonly set: (upstream: URL) => Effect.Effect<void>;
  /** Park new connections until the next `set`. Spliced connections are left alone. */
  readonly unset: () => Effect.Effect<void>;
}

const ADDRESS_IN_USE_CODES: ReadonlySet<string> = new Set([
  "EADDRINUSE",
  "EACCES",
]);

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

const isAddressInUse = (error: ConfigError | SystemError) =>
  error._tag === "ConfigError" && error.subtag === "AddressInUse";

/**
 * The one piece of HTTP the proxy speaks: a connection that will never reach
 * a Worker gets a fixed `502` and is closed. Written onto the raw socket, so
 * it stays clear of any HTTP implementation.
 */
const badGateway = (message: string): string => {
  const body = JSON.stringify({
    ok: false,
    error: { _tag: "ProxyError", message, status: 502 },
  });
  return [
    "HTTP/1.1 502 Bad Gateway",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
};

/** `URL.hostname` keeps the brackets on IPv6 literals; `net.connect` does not want them. */
const connectOptions = (upstream: URL): NodeNet.NetConnectOpts => ({
  host: upstream.hostname.replace(/^\[(.*)\]$/, "$1"),
  port: Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80)),
});

/** An accepted connection whose upstream is not connected yet. */
interface Client {
  readonly socket: NodeNet.Socket;
  /** What the client sent so far, replayed to the upstream before piping. */
  readonly held: Array<Buffer>;
  heldBytes: number;
  readonly collect: (chunk: Buffer) => void;
}

interface Relay {
  target: URL | undefined;
  readonly pendingTimeoutMs: number;
  /** Every live socket, client and upstream, so teardown can destroy them all. */
  readonly sockets: Set<NodeNet.Socket>;
  /** Connections waiting for an upstream, with their give-up timers. */
  readonly parked: Set<{
    readonly client: Client;
    readonly timer: NodeJS.Timeout;
  }>;
  /** Connections spliced to an upstream, by the upstream they were spliced to. */
  readonly spliced: Set<{
    readonly client: NodeNet.Socket;
    readonly upstream: NodeNet.Socket;
    readonly target: URL;
  }>;
}

const reject = (client: Client, message: string) => {
  const { socket } = client;
  if (socket.destroyed) return;
  // The collector keeps consuming so no unread inbound bytes are left on
  // the socket at close (that would make the kernel send RST instead of
  // FIN and could discard the response before the client reads it).
  client.held.length = 0;
  socket.resume();
  socket.end(badGateway(message));
};

const splice = (relay: Relay, client: Client, target: URL) => {
  const { socket } = client;
  const upstream = NodeNet.connect(connectOptions(target));
  relay.sockets.add(upstream);
  upstream.once("close", () => relay.sockets.delete(upstream));
  const pair = { client: socket, upstream, target };
  let connected = false;
  upstream.once("connect", () => {
    connected = true;
    relay.spliced.add(pair);
    // Hand over what the client already sent, then let the pipe take the
    // rest. Detaching the collector and attaching the pipe happen in one
    // synchronous step, so no chunk can slip between them.
    socket.off("data", client.collect);
    for (const chunk of client.held) upstream.write(chunk);
    client.held.length = 0;
    client.heldBytes = 0;
    socket.pipe(upstream);
    socket.resume();
    upstream.pipe(socket);
  });
  upstream.on("error", () => {
    if (connected) {
      socket.destroy();
      return;
    }
    // Nothing has been forwarded yet, so retrying is safe for every method:
    // if the upstream moved while we were connecting (a restart landed
    // between accept and connect), follow it. Otherwise the Worker is gone.
    if (relay.target !== undefined && relay.target.href !== target.href) {
      splice(relay, client, relay.target);
      return;
    }
    reject(client, `Failed to reach the worker (upstream address: ${target})`);
  });
  upstream.on("close", () => {
    // A connect that never succeeded closes too; that client is being
    // rejected or re-spliced elsewhere and must not be torn down here.
    if (!connected) return;
    relay.spliced.delete(pair);
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
};

const park = (relay: Relay, client: Client) => {
  const entry = {
    client,
    timer: setTimeout(() => {
      relay.parked.delete(entry);
      reject(
        client,
        `No worker was available within ${relay.pendingTimeoutMs}ms (the proxy has no upstream)`,
      );
    }, relay.pendingTimeoutMs),
  };
  entry.timer.unref();
  relay.parked.add(entry);
  client.socket.once("close", () => {
    clearTimeout(entry.timer);
    relay.parked.delete(entry);
  });
};

const accept = (relay: Relay) => (socket: NodeNet.Socket) => {
  relay.sockets.add(socket);
  socket.once("close", () => relay.sockets.delete(socket));
  // A client that goes away is not an event anyone else needs to hear about.
  socket.on("error", () => {});
  const client: Client = {
    socket,
    held: [],
    heldBytes: 0,
    collect: (chunk) => {
      client.held.push(chunk);
      client.heldBytes += chunk.length;
      if (client.heldBytes > HOLD_LIMIT_BYTES) socket.pause();
    },
  };
  // Read from the very first tick — see the module doc on Bun.
  socket.on("data", client.collect);
  if (relay.target === undefined) {
    park(relay, client);
  } else {
    splice(relay, client, relay.target);
  }
};

const setTarget = (relay: Relay, upstream: URL) => {
  const previous = relay.target;
  relay.target = upstream;
  for (const entry of relay.parked) {
    relay.parked.delete(entry);
    clearTimeout(entry.timer);
    splice(relay, entry.client, upstream);
  }
  if (previous !== undefined && previous.href !== upstream.href) {
    for (const pair of relay.spliced) {
      if (pair.target.href !== upstream.href) {
        relay.spliced.delete(pair);
        pair.client.destroy();
        pair.upstream.destroy();
      }
    }
  }
};

const closeRelay = (relay: Relay) => {
  relay.target = undefined;
  for (const entry of relay.parked) clearTimeout(entry.timer);
  relay.parked.clear();
  relay.spliced.clear();
  for (const socket of relay.sockets) socket.destroy();
  relay.sockets.clear();
};

const listen = (
  relay: Relay,
  host: string,
  port: number,
): Effect.Effect<NodeNet.Server, ConfigError | SystemError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server, ConfigError | SystemError>((resume) => {
      const server = NodeNet.createServer(accept(relay));
      server.once("error", (error) => {
        const code = errorCode(error);
        resume(
          Effect.fail(
            code !== undefined && ADDRESS_IN_USE_CODES.has(code)
              ? new ConfigError({
                  subtag: "AddressInUse",
                  message: `Address ${host}:${port} is already in use.`,
                  cause: error,
                })
              : new SystemError({
                  subtag: "WorkerProxyListen",
                  message: `Failed to listen on ${host}:${port} for the worker proxy.`,
                  cause: error,
                }),
          ),
        );
      });
      server.listen({ host, port, exclusive: true }, () =>
        resume(Effect.succeed(server)),
      );
      return Effect.sync(() => server.close());
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

export const WorkerProxyLive = Layer.effect(
  WorkerProxy,
  Effect.gen(function* () {
    const ports = yield* Port.make({ cache: true });

    // `localhost` resolves to BOTH 127.0.0.1 and ::1, and browsers prefer
    // IPv6. A proxy bound only on 127.0.0.1 leaves `[::1]:port` free for any
    // other process (e.g. a framework dev server hunting from its default
    // port) to claim — after which `http://localhost:port` silently serves
    // that other process instead of (or interleaved with) the proxy. When
    // serving on the loopback default, bind an additional `[::1]` socket so
    // the proxy owns its port on both address families. Machines without an
    // IPv6 loopback are detected once and skip the extra socket.
    const ipv6Loopback = yield* Effect.callback<boolean>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", () => resume(Effect.succeed(false)));
      server.listen({ port: 0, host: "::1", exclusive: true }, () =>
        server.close(() => resume(Effect.succeed(true))),
      );
      return Effect.sync(() => server.close());
    });

    const normalizeOptions = Effect.fnUntraced(function* (
      options: ServeOptions,
    ) {
      const host = options.host ?? "127.0.0.1";
      const strictPort = options.strictPort ?? false;
      return {
        port:
          options.port && options.strictPort
            ? yield* ports.check(options.port)
            : options.port
              ? // A configured (non-strict) port: a dev-session restart races
                // the previous session's teardown, and an instant fallback
                // would silently shift every configured port in the stack up
                // by one in nondeterministic order — serving the wrong app on
                // the ports the user knows. Wait out the teardown before
                // falling back to the hunt (the caller warns on drift).
                yield* ports
                  .waitFor(options.port)
                  .pipe(Effect.catch(() => ports.find(options.port!)))
              : yield* ports.find(0),
        host,
        strictPort,
        // Dual-bind only for the loopback default — an explicit host is
        // served verbatim.
        ipv6: options.host === undefined && ipv6Loopback,
        pendingTimeoutMs:
          options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS,
        proxySharedSecret: crypto.randomUUID(),
      };
    });
    type ResolvedOptions = Effect.Success<ReturnType<typeof normalizeOptions>>;

    const serve = Effect.fnUntraced(function* ({
      host,
      port,
      ipv6,
      pendingTimeoutMs,
    }: ResolvedOptions) {
      const relay: Relay = {
        target: undefined,
        pendingTimeoutMs,
        sockets: new Set(),
        parked: new Set(),
        spliced: new Set(),
      };
      yield* listen(relay, host, port);
      if (ipv6) {
        // The IPv6 half of `localhost` (see `ipv6Loopback` above). The port
        // was probed across both families by `ports.find`/`check`, so this
        // bind only fails on a genuine race — handled by `serveWithRetry`
        // like any other collision.
        yield* listen(relay, "::1", port);
      }
      // Registered after the listeners so it runs BEFORE them on close:
      // `server.close` only completes once every connection is gone.
      yield* Effect.addFinalizer(() => Effect.sync(() => closeRelay(relay)));
      return {
        relay,
        url: new URL(
          `http://${host === "127.0.0.1" ? "localhost" : host}:${port}`,
        ),
      };
    });

    // Each attempt binds in its own child scope: a collision closes that
    // scope (releasing any listener the attempt did get, e.g. the IPv4 half
    // when the IPv6 bind raced), the winner's scope lives on with the
    // caller's. Every attempt is a plain bind, so retrying is cheap, but it
    // MUST stay bounded: an environmental failure that keeps reporting the
    // port as taken would otherwise scan forever.
    const serveWithRetry: (
      options: ResolvedOptions,
      attempt?: number,
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof serve>>,
      ConfigError | SystemError,
      Scope.Scope
    > = Effect.fnUntraced(function* (options: ResolvedOptions, attempt = 1) {
      const parent = yield* Effect.scope;
      const child = yield* Scope.fork(parent);
      const result = yield* Effect.result(
        serve(options).pipe(Scope.provide(child)),
      );
      if (result._tag === "Success") return result.success;
      yield* Scope.close(child, Exit.void);
      if (
        isAddressInUse(result.failure) &&
        !options.strictPort &&
        options.port <= Port.MAX_PORT &&
        attempt < MAX_SERVE_ATTEMPTS
      ) {
        const port = yield* ports.find(options.port + 1);
        return yield* serveWithRetry({ ...options, port }, attempt + 1);
      }
      return yield* Effect.fail(result.failure);
    });

    return WorkerProxy.of({
      serve: Effect.fn("WorkerProxy.serve")(function* (options = {}) {
        const resolved = yield* normalizeOptions(options);
        const { relay, url } = yield* serveWithRetry(resolved);
        if (
          options.port !== undefined &&
          options.port !== 0 &&
          Number(url.port) !== options.port
        ) {
          yield* Effect.logWarning(
            `Port ${options.port} is in use by another process; serving on ${url.port} instead. Stop the other process, pick a different port, or set \`strictPort: true\` to fail instead.`,
          );
        }
        return {
          url,
          proxySharedSecret: resolved.proxySharedSecret,
          set: (upstream) => Effect.sync(() => setTarget(relay, upstream)),
          unset: () =>
            Effect.sync(() => {
              relay.target = undefined;
            }),
        } satisfies WorkerProxyInstance;
      }),
    });
  }),
);
