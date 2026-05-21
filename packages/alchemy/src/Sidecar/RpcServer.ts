import { RpcSession, type RpcCompatible, type RpcTransport } from "capnweb";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Lock from "./Lock.ts";
import {
  serializeRpcHandlers,
  type RpcHandlerEncoders,
  type RpcHandlers,
} from "./RpcHandler.ts";
import * as RpcPaths from "./RpcPaths.ts";

export class RpcServer extends Context.Service<
  RpcServer,
  {
    make: <T extends RpcCompatible<T>>(
      main: () => T,
    ) => Effect.Effect<
      {
        readonly url: string;
      },
      never,
      Scope.Scope
    >;
  }
>()("RpcServer") {}

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
    const server = yield* RpcServer.use((server) =>
      server.make(() =>
        Object.assign(serializeRpcHandlers(handlers, schema), {
          heartbeat: () => Effect.runPromise(heartbeat.touch),
          shutdown: () => Effect.runPromise(heartbeat.shutdown),
        }),
      ),
    );
    yield* fs.writeFileString(paths.url, server.url);
    yield* Effect.addFinalizer(() =>
      fs.readFileString(paths.url).pipe(
        Effect.flatMap((text) =>
          text === server.url ? fs.remove(paths.url) : Effect.void,
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

interface ServerWebSocketLike {
  send: (message: string) => any | Promise<any>;
  close: (code?: number, reason?: string) => void;
}

export type WebSocketRpcSession<T extends RpcCompatible<T>> = ReturnType<
  typeof makeWebSocketRpcSession<T>
>;

export function makeWebSocketRpcSession<T extends RpcCompatible<T>>(
  ws: ServerWebSocketLike,
  main: () => T,
) {
  const { transport, dispatch } = makeWebSocketRpcTransport(ws);
  const session = new RpcSession(transport, main());
  return { session, dispatch };
}

function makeWebSocketRpcTransport(ws: ServerWebSocketLike) {
  let receiveQueue: Array<string> = [];
  let receiveResolver: ((value: string) => void) | undefined;
  let receiveRejecter: ((reason: unknown) => void) | undefined;
  let error: unknown | undefined;
  return {
    transport: {
      send: async (message: string) => await ws.send(message),
      receive: async () => {
        const next = receiveQueue.shift();
        if (next) {
          return next;
        } else if (error) {
          throw error;
        }
        return new Promise<string>((resolve, reject) => {
          receiveResolver = resolve;
          receiveRejecter = reject;
        });
      },
      abort: (reason: unknown) => {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        ws.close(3000, message);
        error ??= reason;
      },
    } satisfies RpcTransport,
    dispatch: {
      message: (data: string | Buffer<ArrayBuffer>) => {
        if (error) {
          return;
        }
        data = typeof data === "string" ? data : data.toString("utf-8");
        if (receiveResolver) {
          receiveResolver(data);
          receiveResolver = undefined;
          receiveRejecter = undefined;
        } else {
          receiveQueue.push(data);
        }
      },
      close: (code: number, reason: string) => {
        if (!error) {
          error = new Error(`WebSocket closed with code ${code}: ${reason}`);
          if (receiveRejecter) {
            receiveRejecter(error);
            receiveRejecter = undefined;
            receiveResolver = undefined;
          }
        }
      },
    },
  };
}
