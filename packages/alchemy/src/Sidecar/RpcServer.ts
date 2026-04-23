import { Layer } from "effect";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Config from "../Config.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import * as Lock from "./Lock.ts";
import {
  serializeRpcHandlers,
  type RpcHandlerEncoders,
  type RpcHandlers,
} from "./RpcHandler.ts";
import * as RpcPaths from "./RpcPaths.ts";
import { makeBunWebSocketRpcServer } from "./RpcTransport.ts";

export const layerServices = (main: string) =>
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.effect(
        Lock.Lock,
        Effect.gen(function* () {
          const lock = yield* Lock.make;
          yield* lock.acquire;
          return lock;
        }),
      ),
      Layer.provideMerge(RpcPaths.layer(main), Config.dotAlchemy),
    ),
    PlatformServices,
  );

export const makeRpcServer = Effect.fn(function* <T extends RpcHandlers>(
  handlers: T,
  schema: RpcHandlerEncoders<T>,
) {
  const paths = yield* RpcPaths.RpcPaths;
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Lock.Lock;
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeBunWebSocketRpcServer(() =>
        Object.assign(serializeRpcHandlers(handlers, schema), {
          heartbeat: () => Effect.runPromise(lock.touch),
          shutdown: () => {
            console.log("shutting down RPC server");
            return Effect.runPromise(lock.release);
          },
        }),
      ),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  );
  yield* fs.writeFileString(
    paths.url,
    `ws://${server.hostname}:${server.port}`,
  );
  yield* Effect.addFinalizer(() =>
    Effect.ignore(fs.remove(paths.url, { force: true })),
  );
  yield* lock.monitor;
});
