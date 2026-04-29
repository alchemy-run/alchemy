import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as AlchemyContext from "../AlchemyContext.ts";
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
    Lock.LockLive,
    Layer.provideMerge(RpcPaths.layer(main), AlchemyContext.AlchemyContextLive),
  );

export const makeRpcServer = Effect.fn(function* <T extends RpcHandlers, E, R>(
  handlersEffect: Effect.Effect<T, E, R>,
  schema: RpcHandlerEncoders<T>,
) {
  const lock = yield* Lock.Lock.use((lock) => lock.acquire);
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* RpcPaths.RpcPaths;

  const server = yield* Effect.gen(function* () {
    const heartbeat = yield* Heartbeat;
    const handlers = yield* handlersEffect;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makeBunWebSocketRpcServer(() => {
          const methods = Object.assign(
            serializeRpcHandlers(handlers, schema),
            {
              heartbeat: () => Effect.runPromise(heartbeat.touch),
              shutdown: () => Effect.runPromise(heartbeat.shutdown),
            },
          );
          void methods.heartbeat();
          return methods;
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );
    const address = `ws://${server.hostname}:${server.port}`;
    yield* fs.writeFileString(paths.url, address);
    yield* Effect.addFinalizer(() =>
      fs.readFileString(paths.url).pipe(
        Effect.flatMap((text) =>
          text === address ? fs.remove(paths.url) : Effect.void,
        ),
        Effect.ignore,
      ),
    );
    yield* heartbeat.await;
  }).pipe(Effect.forkScoped);

  yield* Fiber.joinAll([lock, server]);
});

const Heartbeat = Effect.gen(function* () {
  let last = Date.now();
  const fiber = yield* Effect.suspend(() => {
    if (Date.now() - last > 10_000) {
      return Effect.fail({ _tag: "Timeout" } as const);
    }
    return Effect.void;
  }).pipe(Effect.repeat(Schedule.spaced("4 seconds")), Effect.forkScoped);
  return {
    touch: Effect.sync(() => {
      last = Date.now();
    }),
    shutdown: Fiber.interrupt(fiber),
    await: Fiber.join(fiber),
  };
});
