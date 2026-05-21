import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WebSocketServer, type Server } from "ws";
import { makeWebSocketRpcSession, RpcServer } from "./RpcServer.ts";

export const RpcServerNode = Layer.succeed(
  RpcServer,
  RpcServer.of({
    make: Effect.fnUntraced(function* (main) {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const url = yield* Effect.callback<string>((resume) => {
        server.on("connection", (ws) => {
          const session = makeWebSocketRpcSession(ws, main);
          ws.on("message", (data) => {
            session.dispatch.message(data.toString());
          });
          ws.on("close", (code, reason) => {
            session.dispatch.close(code, reason.toString());
          });
        });
        server.on("error", (error) => {
          resume(Effect.die(error));
        });
        server.on("listening", () => {
          resume(getServerAddress(server));
        });
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
      return { url };
    }),
  }),
);

function getServerAddress(server: Server): Effect.Effect<string> {
  const address = server.address();
  if (
    typeof address === "object" &&
    address !== null &&
    "address" in address &&
    "port" in address
  ) {
    return Effect.succeed(
      `ws://${address.address === "::" ? "localhost" : address.address}:${address.port}`,
    );
  }
  return Effect.die(
    new Error(
      `Server address is not an object with address and port properties: ${JSON.stringify(address)}`,
    ),
  );
}
