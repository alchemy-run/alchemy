import { newWebSocketRpcSession } from "capnweb";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import * as Lock from "./Lock.ts";
import {
  deserializeRpcHandlers,
  type RpcHandlerDecoders,
  type RpcHandlers,
  type SerializedRpcHandlers,
} from "./RpcHandler.ts";
import * as RpcPaths from "./RpcPaths.ts";

export const RpcClientService = <Self, T extends RpcHandlers>() =>
  Context.Service<Self, T>();

class RpcClientError extends Schema.TaggedErrorClass<RpcClientError>()(
  "RpcClientError",
  {
    reason: Schema.Literals(["InvalidURL", "WebSocketError"]),
    message: Schema.String,
    cause: Schema.optional(Schema.DefectWithStack),
  },
) {}

export const layer = <Self, T extends RpcHandlers>(
  tag: Context.ServiceClass<Self, any, T>,
  options: {
    main: string;
    schema: RpcHandlerDecoders<T>;
  },
) =>
  Layer.effect(
    tag,
    Effect.gen(function* () {
      const fiber = yield* maybeStartRpcServer(
        fileURLToPath(options.main),
      ).pipe(
        Effect.flatMap(() => RpcSession),
        Effect.map((session) =>
          deserializeRpcHandlers(
            session as SerializedRpcHandlers<T>,
            options.schema,
          ),
        ),
        Effect.retry(Schedule.exponential("100 millis")),
        Effect.provide(
          Layer.provideMerge(Lock.LockLive, RpcPaths.layer(options.main)),
        ),
        Effect.forkScoped,
      );
      return new Proxy({} as T, {
        get(target, prop) {
          return (...args: any[]) =>
            Fiber.join(fiber).pipe(
              Effect.flatMap((session) => session[prop as never](...args)),
            );
        },
      });
    }),
  );

const maybeStartRpcServer = Effect.fn(function* (main: string) {
  const lock = yield* Lock.Lock;
  if (!(yield* lock.check)) {
    yield* Effect.logDebug("[RpcClient] Starting RPC server", main);
    yield* ChildProcess.make("bun", ["run", main], {
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
  } else {
    yield* Effect.logDebug("[RpcClient] RPC server already running", main);
  }
});

const RpcSession = Effect.gen(function* () {
  const paths = yield* RpcPaths.RpcPaths;
  const fs = yield* FileSystem.FileSystem;
  const ws = yield* fs.readFileString(paths.url).pipe(
    Effect.flatMap((url) =>
      Effect.try({
        try: () => new URL(url),
        catch: (e) =>
          new RpcClientError({
            reason: "InvalidURL",
            message: `"${url}" is not a valid URL`,
            cause: e,
          }),
      }),
    ),
    Effect.flatMap((url) =>
      Effect.callback<WebSocket, RpcClientError>((resume) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resume(Effect.succeed(ws));
        ws.onerror = (e) =>
          resume(
            Effect.fail(
              new RpcClientError({
                reason: "WebSocketError",
                message: "WebSocket connection failed",
                cause: e,
              }),
            ),
          );
        return Effect.sync(() => ws.close());
      }),
    ),
    Effect.retry({
      while: (e) => e.reason !== "WebSocketError",
      schedule: Schedule.spaced("50 millis"),
      times: 100,
    }),
    Effect.retry({
      while: (e) => e.reason === "WebSocketError",
      schedule: Schedule.exponential("100 millis"),
      times: 3,
    }),
  );
  const session = yield* Effect.acquireRelease(
    Effect.sync(() =>
      newWebSocketRpcSession<{
        heartbeat: () => Promise<void>;
        shutdown: () => Promise<void>;
      }>(ws),
    ),
    (session) => Effect.sync(() => session[Symbol.dispose]()),
  );
  yield* Effect.promise(() => session.heartbeat()).pipe(
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.ensuring(Effect.promise(() => session.shutdown())),
    Effect.forkScoped,
  );
  return session;
});
