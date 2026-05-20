import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcServer from "./RpcServer.ts";

export const RpcServerBun = Layer.effect(
  RpcServer.RpcServer,
  RpcServer.make(
    Effect.fnUntraced(function* (handlers) {
      let count = 0;
      const server = yield* Effect.sync(() =>
        Bun.serve<
          | { type: "session"; session: RpcServer.WebSocketRpcSession<any> }
          | { type: "signal" }
        >({
          port: 0,
          fetch: (request, server) => {
            const url = new URL(request.url);
            console.log("fetch", url.pathname);
            if (
              server.upgrade(request, {
                data:
                  url.pathname === "/signal" ? { type: "signal" } : undefined!,
              })
            ) {
              return;
            }
            return new Response("Upgrade failed", { status: 400 });
          },
          websocket: {
            open: (ws) => {
              count++;
              console.log("open", count);
              if (ws.data && ws.data.type === "signal") {
                handlers.connect();
              } else {
                ws.data = {
                  type: "session",
                  session: handlers.session(ws),
                };
              }
            },
            message: (ws, message) => {
              if (ws.data.type === "session") {
                ws.data.session.dispatch.message(message);
              }
            },
            close: (ws, code, reason) => {
              if (ws.data.type === "session") {
                ws.data.session.dispatch.close(code, reason);
              } else if (ws.data.type === "signal") {
                handlers.disconnect();
              }
              count--;
              console.log("close", count);
            },
          },
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
      return {
        url: `ws://${server.hostname}:${server.port}`,
      };
    }),
  ),
);
