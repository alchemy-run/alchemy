import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { isWorkerd } from "./Transport.ts";

/** The part of `cloudflare:sockets` this module uses. */
type CloudflareConnect = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on" | "off"; allowHalfOpen: boolean },
) => {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
};

/** The parts of `node:net`, `node:tls` and `node:stream` this module uses. */
interface NodeDuplex {
  destroy(): void;
}
type NodeConnect = (options: { host: string; port: number; servername?: string }) => NodeDuplex;
interface NodeStreamModule {
  readonly Duplex: {
    toWeb(duplex: NodeDuplex): Socket.InputTransformStream;
  };
}

// Non-literal specifiers keep a bundler from pulling one runtime's sockets
// into the other's bundle: workerd resolves `cloudflare:sockets` at runtime,
// and Node resolves its built-ins.
const CLOUDFLARE_SOCKETS = "cloudflare:sockets";
const NODE_NET = "node:net";
const NODE_TLS = "node:tls";
const NODE_STREAM = "node:stream";

const importModule = <A>(specifier: string) =>
  Effect.tryPromise({
    try: () => import(/* @vite-ignore */ specifier) as Promise<A>,
    catch: (cause) =>
      Socket.SocketError.make({ reason: Socket.SocketOpenError.make({ kind: "Unknown", cause }) }),
  });

const openCloudflare = (host: string, port: number, tls: boolean) =>
  Effect.acquireRelease(
    Effect.map(importModule<{ connect: CloudflareConnect }>(CLOUDFLARE_SOCKETS), ({ connect }) =>
      connect(
        { hostname: host, port },
        { secureTransport: tls ? "on" : "off", allowHalfOpen: false },
      ),
    ),
    (socket) => Effect.promise(() => socket.close().catch(() => undefined)),
  );

const openNode = (host: string, port: number, tls: boolean) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const { Duplex } = yield* importModule<NodeStreamModule>(NODE_STREAM);
      const { connect } = yield* importModule<{ connect: NodeConnect }>(tls ? NODE_TLS : NODE_NET);
      const duplex = connect(tls ? { host, port, servername: host } : { host, port });
      return { duplex, stream: Duplex.toWeb(duplex) };
    }),
    ({ duplex }) => Effect.sync(() => duplex.destroy()),
  ).pipe(Effect.map(({ stream }) => stream));

/**
 * A TCP socket to `host:port`, over TLS when `tls` is set: `cloudflare:sockets`
 * on workerd, Node's `net`/`tls` elsewhere. It connects when run.
 */
export const connectTcp = (options: {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
}): Effect.Effect<Socket.Socket> =>
  Socket.fromTransformStream(
    Effect.suspend(() =>
      isWorkerd()
        ? openCloudflare(options.host, options.port, options.tls)
        : openNode(options.host, options.port, options.tls),
    ),
  );
