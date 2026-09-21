import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
export const findAvailablePort = (host = "127.0.0.1") =>
  Effect.callback<number, Error>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(0, host, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null
          ? address.port
          : undefined;
      server.close((error) => {
        if (error) {
          resume(Effect.fail(error));
        } else if (port !== undefined) {
          resume(Effect.succeed(port));
        } else {
          resume(
            Effect.fail(new Error("Failed to allocate an available port")),
          );
        }
      });
    });
  });
