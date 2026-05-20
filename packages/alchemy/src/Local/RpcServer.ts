import { RpcSession, type RpcCompatible, type RpcTransport } from "capnweb";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ProviderService } from "../Provider.ts";
import { serializeRpcHandlers, type Rpc } from "./RpcSerialization.ts";

export class RpcServer extends Context.Service<RpcServer, never>()(
  "RpcServer",
) {}

export type RpcProvider = {
  [K in keyof ProviderService]: Rpc.ToSerialized<ProviderService[K]>;
};

export interface RpcApi {
  getProvider: (key: string) => RpcProvider;
}

export const make = Effect.fnUntraced(function* (
  serve: <T extends RpcCompatible<T>>(handlers: {
    session: (ws: ServerWebSocketLike) => WebSocketRpcSession<T>;
    connect: () => void;
    disconnect: () => void;
  }) => Effect.Effect<{ readonly url: string }, never, Scope.Scope>,
) {
  const context = yield* Effect.context();
  const signalConnect = yield* Deferred.make<void>();
  const signalDisconnect = yield* Deferred.make<void>();
  const api: RpcApi = {
    getProvider: (key) => {
      const provider = context.mapUnsafe.get(key);
      if (!provider) {
        throw new Error(`Provider "${key}" not found`);
      }
      return serializeRpcHandlers(provider as ProviderService, ["tail"]);
    },
  };
  const { url } = yield* serve({
    session: (ws) => makeWebSocketRpcSession(ws, api),
    connect: () => Deferred.doneUnsafe(signalConnect, Effect.void),
    disconnect: () => Deferred.doneUnsafe(signalDisconnect, Effect.void),
  });
  yield* Console.log(`<ALCHEMY_RPC_ADDRESS>${url}</ALCHEMY_RPC_ADDRESS>`);
  yield* Deferred.await(signalConnect).pipe(Effect.timeout("10 seconds")); // TODO(john): should the timeout be shorter?
  return yield* Deferred.await(signalDisconnect) as Effect.Effect<never>;
});

interface ServerWebSocketLike {
  send: (message: string) => any | Promise<any>;
  close: (code?: number, reason?: string) => void;
}

export type WebSocketRpcSession<T extends RpcCompatible<T>> = ReturnType<
  typeof makeWebSocketRpcSession<T>
>;

function makeWebSocketRpcSession<T extends RpcCompatible<T>>(
  ws: ServerWebSocketLike,
  main: T,
) {
  const { transport, dispatch } = makeWebSocketRpcTransport(ws);
  const session = new RpcSession(transport, main);
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
