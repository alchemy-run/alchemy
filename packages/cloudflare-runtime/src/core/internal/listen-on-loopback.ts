import type * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import { SystemError } from "../RuntimeError.shared.ts";

/** Listen on loopback; the owning scope closes the server, including failed starts. */
export const listenOnLoopback = Effect.fnUntraced(function* (server: NodeNet.Server) {
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      server.close();
    }),
  );
  yield* Effect.callback<void, SystemError>((resume) => {
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(
        Effect.fail(
          new SystemError({
            subtag: "DockerProxyListen",
            message: "Failed to start the Docker proxy.",
            cause,
          }),
        ),
      );
    };
    const onListening = () => {
      cleanup();
      resume(Effect.void);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
    return Effect.sync(cleanup);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* new SystemError({
      subtag: "DockerProxyAddress",
      message: "Docker proxy has no TCP address.",
    });
  }
  return address.port;
});
