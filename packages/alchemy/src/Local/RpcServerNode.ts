import * as Effect from "effect/Effect";
import { WebSocketServer, type Server } from "ws";
import * as RpcServer from "./RpcServer.ts";
import { SESSION_ENV_PARAM } from "./RpcServerEnvironment.ts";
import { matchRpcToken, requestPathname } from "./RpcToken.ts";

export const RpcServerNode = RpcServer.layerServer(
  Effect.fn(function* ({ parentConnected, parentDisconnected, createRpcSession, token }) {
    const route = (url: string | undefined) => {
      const rest = matchRpcToken(requestPathname(url), token);
      return rest === "/parent" ? "parent" : rest === "" ? "session" : undefined;
    };
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      // Refuse the upgrade (401) unless the URL carries the token.
      verifyClient: (info: { req: { url?: string } }) => route(info.req.url) !== undefined,
    });
    const url = yield* Effect.callback<string>((resume) => {
      server.on("connection", (ws, req) => {
        const kind = route(req.url);
        if (kind === undefined) {
          ws.close(1008, "unauthorized");
          return;
        }
        if (kind === "parent") {
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
