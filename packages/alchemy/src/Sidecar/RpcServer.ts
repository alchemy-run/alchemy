import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Config from "../Config.ts";
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
    Layer.effect(
      Lock.Lock,
      Effect.gen(function* () {
        const lock = yield* Lock.make;
        yield* lock.acquire;
        yield* Effect.addFinalizer(() => Effect.ignore(lock.release));
        return lock;
      }),
    ),
    Layer.provideMerge(RpcPaths.layer(main), Config.dotAlchemy),
  );

export const makeRpcServer = Effect.fn(function* <T extends RpcHandlers, E, R>(
  handlersEffect: Effect.Effect<T, E, R | Scope.Scope>,
  schema: RpcHandlerEncoders<T>,
) {
  const paths = yield* RpcPaths.RpcPaths;
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Lock.Lock;
  const scope = yield* Effect.scope.pipe(Effect.flatMap(Scope.fork));
  const handlers = yield* handlersEffect.pipe(Scope.provide(scope));

  const shutdown = Effect.all(
    [
      Scope.close(scope, Exit.void),
      lock.release,
      fs.remove(paths.url, { force: true }),
    ],
    {
      concurrency: "unbounded",
    },
  );

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeBunWebSocketRpcServer(() =>
        Object.assign(serializeRpcHandlers(handlers, schema), {
          heartbeat: () => Effect.runPromise(lock.touch),
          shutdown: () => Effect.runPromise(shutdown),
        }),
      ),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  );
  yield* fs.writeFileString(
    paths.url,
    `ws://${server.hostname}:${server.port}`,
  );
  yield* Effect.addFinalizer(() => shutdown.pipe(Effect.ignore));
  yield* lock.monitor.pipe(
    Effect.catchIf(
      (e) => e.reason === "Cancelled",
      () => Effect.void,
    ),
  );
});
