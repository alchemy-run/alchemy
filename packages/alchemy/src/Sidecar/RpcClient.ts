import { newWebSocketRpcSession } from "capnweb";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
  Layer.provide(
    Layer.effect(
      tag,
      maybeStartRpcServer(fileURLToPath(options.main)).pipe(
        Effect.flatMap(() => RpcSession),
        Effect.map((session) =>
          deserializeRpcHandlers(
            session as SerializedRpcHandlers<T>,
            options.schema,
          ),
        ),
      ),
    ),
    Layer.provideMerge(Lock.layer, RpcPaths.layer(options.main)),
  );

const maybeStartRpcServer = Effect.fn(function* (main: string) {
  const lock = yield* Lock.Lock;
  if (!(yield* lock.check)) {
    console.log("[RpcClient] Starting RPC server", main);
    yield* ChildProcess.make("bun", ["run", main], {
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
  } else {
    console.log("[RpcClient] RPC server already running", main);
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
    Effect.retry({}),
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
  yield* Effect.promise(() => {
    // TODO(john): Remove log after CLI is fixed
    console.log("[RpcClient] sending heartbeat");
    return session.heartbeat();
  }).pipe(
    Effect.repeat(Schedule.spaced(Duration.times(Lock.LOCK_TTL, 0.4))),
    Effect.ensuring(Effect.promise(() => session.shutdown())),
    Effect.forkScoped,
  );
  return session;
});
