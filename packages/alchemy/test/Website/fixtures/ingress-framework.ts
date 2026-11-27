import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";

/**
 * A framework-integration module (the contract `Website.Server` loads from
 * `props.framework`) whose dev server is a tiny HTTP server on a free
 * loopback port. It answers every request with `<path> <host>`, so a test sees
 * which name reached it. The server lives in the ambient Scope, as a real
 * framework's does.
 */
export const make = () =>
  Effect.succeed({
    build: () => Effect.die("The ingress fixture has no production build"),
    dev: () =>
      Effect.gen(function* () {
        const server = NodeHttp.createServer((request, response) => {
          response
            .writeHead(200, { "content-type": "text/plain" })
            .end(`${request.url} ${request.headers.host}`);
        });
        yield* Effect.acquireRelease(
          Effect.callback<void>((resume) => {
            server.listen(0, "127.0.0.1", () => resume(Effect.void));
          }),
          () =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
              server.closeAllConnections();
            }),
        );
        return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      }),
  });
