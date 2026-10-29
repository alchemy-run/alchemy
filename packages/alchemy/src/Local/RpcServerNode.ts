import * as Effect from "effect/Effect";
import { WebSocketServer, type Server } from "ws";
import * as RpcServer from "./RpcServer.ts";
import { SESSION_ENV_PARAM } from "./RpcServerEnvironment.ts";
import { isAuthorizedRpcRequest } from "./RpcToken.ts";

export const RpcServerNode = RpcServer.layerServer(
  Effect.fn(function* ({ token, parentConnected, parentDisconnected, createRpcSession }) {
    const server: Server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: ({ req }, done) => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : undefined;
        done(
          isAuthorizedRpcRequest(
            {
              url: req.url ?? "/",
              headers: { host: req.headers.host, origin: req.headers.origin },
            },
            { token, host: `127.0.0.1:${port}` },
          ),
          401,
        );
      },
    });
    const url = yield* Effect.callback<string>((resume) => {
      server.on("connection", (ws, req) => {
        if (req.url?.startsWith("/parent")) {
          parentConnected();
          ws.on("close", () => {
            parentDisconnected();
          });
          return;
        }
        const sessionEnv =
          new URL(req.url ?? "/", "http://localhost").searchParams.get(SESSION_ENV_PARAM) ??
          undefined;
        const session = createRpcSession(ws, sessionEnv);
        ws.on("message", (data) => {
          session.dispatch.message(
            (Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.isBuffer(data)
                ? data
                : Buffer.from(data)
            ).toString(),
          );
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
