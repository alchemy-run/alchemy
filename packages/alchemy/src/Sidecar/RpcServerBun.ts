import type { RpcCompatible } from "capnweb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WebSocketRpcSession } from "./RpcServer.ts";
import { makeWebSocketRpcSession, RpcServer } from "./RpcServer.ts";

export const RpcServerBun = Layer.succeed(
  RpcServer,
  RpcServer.of({
    make: <T extends RpcCompatible<T>>(main: () => T) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve<WebSocketRpcSession<T>>({
            port: 0,
            fetch: (request, server) => {
              if (server.upgrade(request, { data: undefined! })) {
                return;
              }
              return new Response("Upgrade failed", { status: 400 });
            },
            websocket: {
              open: (ws) => {
                ws.data = makeWebSocketRpcSession(ws, main);
              },
              message: (ws, message) => {
                ws.data.dispatch.message(message);
              },
              close: (ws, code, reason) => {
                ws.data.dispatch.close(code, reason);
              },
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      ).pipe(
        Effect.map((server) => ({
          url: `ws://${server.hostname}:${server.port}`,
        })),
      ),
  }),
);
