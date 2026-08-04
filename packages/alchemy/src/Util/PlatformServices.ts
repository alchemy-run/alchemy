import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { Path } from "effect/Path";
import { defaultTeardown, type Teardown } from "effect/Runtime";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { HttpServer } from "effect/unstable/http/HttpServer";
import type { ServeError } from "effect/unstable/http/HttpServerError";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { WebSocketConstructor } from "effect/unstable/socket/Socket";

const isBun = typeof Bun !== "undefined";

/**
 * Constructs a layer with different implementations for Bun and Node.
 */
export const platformLayer = <A, E, R>(constructors: {
  bun: () => Promise<Layer.Layer<A, E, R>>;
  node: () => Promise<Layer.Layer<A, E, R>>;
}) =>
  Layer.unwrap(
    Effect.promise(async () => {
      if (isBun) {
        return await constructors.bun();
      } else {
        return await constructors.node();
      }
    }),
  );

export type PlatformServices =
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal
  // WebSocketConstructor is not included in NodeServices/BunServices, but required for Workers tail
  | WebSocketConstructor;

export const PlatformServices: Layer.Layer<PlatformServices> = platformLayer({
  bun: async () => {
    const [BunServices, BunSocket] = await Promise.all([
      import("@effect/platform-bun/BunServices"),
      import("@effect/platform-bun/BunSocket"),
    ]);
    return Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor);
  },
  node: async () => {
    const [NodeServices, NodeSocket] = await Promise.all([
      import("@effect/platform-node/NodeServices"),
      import("@effect/platform-node/NodeSocket"),
    ]);
    return Layer.merge(
      NodeServices.layer,
      NodeSocket.layerWebSocketConstructor,
    );
  },
});

/**
 * ALWAYS exit once the main effect completes. The platform `runMain` default
 * only force-exits on failure or signal interruption — a *successful*
 * `alchemy deploy`/`destroy` otherwise lingers for ~100 seconds after "Done"
 * while keep-alive sockets (Cloudflare API agents, provider sidecar handles)
 * pin the event loop until the remote side closes them. All Effect finalizers
 * have already run by the time teardown is invoked; the macrotask hop lets
 * any buffered stdout drain before the process exits.
 */
const exitingTeardown: Teardown = (exit, onExit) => {
  defaultTeardown(exit, (code) => {
    const finalCode = code !== 0 ? code : Number(process.exitCode ?? 0) || 0;
    setTimeout(() => process.exit(finalCode), 0);
    onExit(finalCode);
  });
};

export const runMain = <E, A>(
  effect: Effect.Effect<A, E>,
  options?: {
    readonly disableErrorReporting?: boolean | undefined;
    readonly teardown?: Teardown | undefined;
  },
): void => {
  const opts = {
    ...options,
    teardown: options?.teardown ?? exitingTeardown,
  };
  if (isBun) {
    void import("@effect/platform-bun/BunRuntime").then((BunRuntime) =>
      BunRuntime.runMain(effect, opts),
    );
  } else {
    void import("@effect/platform-node/NodeRuntime").then((NodeRuntime) =>
      NodeRuntime.runMain(effect, opts),
    );
  }
};

export const httpServer = (
  port: number = 0,
  host: string = "127.0.0.1",
): Layer.Layer<HttpServer, ServeError> =>
  platformLayer({
    bun: async () => {
      const BunHttpServer = await import("@effect/platform-bun/BunHttpServer");
      // `idleTimeout: 0` disables Bun's default 10s request idle timeout.
      // The RPC spawner serves a long-lived `/logs` stream (sidecar output
      // forwarded to the exec child's renderer) that can legitimately sit
      // idle between lines; Bun would otherwise sever it mid-session.
      return BunHttpServer.layer({ hostname: host, port, idleTimeout: 0 });
    },
    node: async () => {
      const [NodeHttpServer, Http] = await Promise.all([
        import("@effect/platform-node/NodeHttpServer"),
        import("node:http"),
      ]);
      return NodeHttpServer.layerServer(Http.createServer, { host, port });
    },
  });
