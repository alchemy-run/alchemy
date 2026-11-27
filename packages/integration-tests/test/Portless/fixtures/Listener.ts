import * as NodeHttp from "node:http";
import { findAvailablePort } from "alchemy/Util/Node";
import * as Effect from "effect/Effect";

/**
 * An existing listener, such as the emulator or admin page an Alias names: a
 * plain HTTP server on a free loopback port, closed with the scope.
 */
export const listener = (name: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const port = yield* findAvailablePort();
      const server = NodeHttp.createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ listener: name }));
      });
      yield* Effect.callback<void, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(port, "127.0.0.1", () => resume(Effect.void));
      });
      return { port, url: `http://localhost:${port}`, server };
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  ).pipe(Effect.map(({ port, url }) => ({ port, url })));
