import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import { FrameworkError } from "./Framework.ts";

/**
 * Allocate a concrete ephemeral port for a framework dev server.
 *
 * Frameworks (and the listeners under them — Vite, listhen/get-port-please,
 * `next dev`) treat `port: 0` as "no port given" and fall back to hunting
 * upward from their well-known default (3000/4321/5173). Those defaults are
 * exactly where users configure their `alchemy dev` proxy ports, so a
 * framework child hunting from its default can land on — or IPv6-shadow —
 * a port the user is browsing. Probing a real ephemeral port from the OS
 * keeps dev servers out of user-visible port ranges entirely.
 *
 * The tiny probe→listen race is handled by the caller passing the port with
 * non-strict semantics: on a genuine collision the framework moves to the
 * next port, still in the ephemeral range.
 */
export const findEphemeralPort = (
  host = "127.0.0.1",
): Effect.Effect<number, FrameworkError> =>
  Effect.callback<number, FrameworkError>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", (error) =>
      resume(
        Effect.fail(
          new FrameworkError({
            message: "Failed to allocate an ephemeral dev-server port",
            cause: error,
          }),
        ),
      ),
    );
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null
          ? address.port
          : undefined;
      server.close(() => {
        if (port !== undefined) {
          resume(Effect.succeed(port));
        } else {
          resume(
            Effect.fail(
              new FrameworkError({
                message: "Failed to allocate an ephemeral dev-server port",
              }),
            ),
          );
        }
      });
    });
    return Effect.sync(() => server.close());
  });
