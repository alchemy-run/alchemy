import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { Path } from "effect/Path";
import type { Teardown } from "effect/Runtime";
import type { Stdio } from "effect/Stdio";
import type { Terminal } from "effect/Terminal";
import type { HttpServer } from "effect/unstable/http/HttpServer";
import type { ServeError } from "effect/unstable/http/HttpServerError";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import type { WebSocketConstructor } from "effect/unstable/socket/Socket";
import { installLocalhostDns } from "./LocalhostDns.ts";

const isBun = typeof Bun !== "undefined";

export type PlatformServices =
  | ChildProcessSpawner
  | FileSystem
  | Path
  | Stdio
  | Terminal
  // WebSocketConstructor is not included in NodeServices/BunServices, but required for Workers tail
  | WebSocketConstructor;

export const PlatformServices: Layer.Layer<PlatformServices> = Effect.promise(
  async () => {
    if (isBun) {
      const [BunServices, BunSocket] = await Promise.all([
        import("@effect/platform-bun/BunServices"),
        import("@effect/platform-bun/BunSocket"),
      ]);
      return Layer.merge(
        BunServices.layer,
        BunSocket.layerWebSocketConstructor,
      );
    } else {
      const [NodeServices, NodeSocket] = await Promise.all([
        import("@effect/platform-node/NodeServices"),
        import("@effect/platform-node/NodeSocket"),
      ]);
      return Layer.merge(
        NodeServices.layer,
        NodeSocket.layerWebSocketConstructor,
      );
    }
  },
).pipe(Layer.unwrap);

export const runMain = <E, A>(
  effect: Effect.Effect<A, E>,
  options?: {
    readonly disableErrorReporting?: boolean | undefined;
    readonly teardown?: Teardown | undefined;
  },
): void => {
  installLocalhostDns();
  if (isBun) {
    void import("@effect/platform-bun/BunRuntime").then((BunRuntime) =>
      BunRuntime.runMain(effect, options),
    );
  } else {
    void import("@effect/platform-node/NodeRuntime").then((NodeRuntime) =>
      NodeRuntime.runMain(effect, options),
    );
  }
};

export const httpServer = (
  port: number = 0,
  host: string = "127.0.0.1",
): Layer.Layer<HttpServer, ServeError> =>
  Effect.promise(async () => {
    if (isBun) {
      const BunHttpServer = await import("@effect/platform-bun/BunHttpServer");
      return BunHttpServer.layer({ hostname: host, port });
    } else {
      const [NodeHttpServer, Http] = await Promise.all([
        import("@effect/platform-node/NodeHttpServer"),
        import("node:http"),
      ]);
      return NodeHttpServer.layerServer(Http.createServer, { host, port });
    }
  }).pipe(Layer.unwrap);
