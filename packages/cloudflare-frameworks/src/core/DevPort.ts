import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import { FrameworkError } from "./Framework.ts";

/**
 * Allocate a concrete ephemeral port for a framework dev server.
 *
 * Vite < 8.2.1 treats `port: 0` as "no port given" and falls back to hunting
 * upward from its well-known default (5173, or the framework's own — 4321
 * for Astro). Those defaults are exactly where users configure their
 * `alchemy dev` proxy ports, so a framework child hunting from its default
 * can land on — or IPv6-shadow — a port the user is browsing. Probing a
 * real ephemeral port from the OS keeps dev servers out of user-visible
 * port ranges entirely.
 *
 * This is deliberately a hint, not a claim: the probe→listen window is a
 * TOCTOU race, so every caller passes the port with non-strict semantics
 * (on a genuine collision the framework moves to the next port, still in
 * the ephemeral range) and wires the proxy to the URL the framework
 * REPORTS after binding, never to the probed number — a lost race can
 * shift a dev server by one port; it cannot serve the wrong app.
 *
 * TODO(vite>=8.2.1): vitejs/vite#23158 (shipped in Vite 8.2.1) makes
 * `port: 0` a true OS-assigned random port. Once the supported Vite floor
 * is >= 8.2.1 (the frameworks drive the PROJECT's Vite install, so this is
 * gated on what user projects run, not on our own dependency), the
 * Vite-based dev servers (SvelteKit, Waku, Octane, Astro, and the plain
 * Vite child in alchemy) should pass `port: 0` and this helper should be
 * deleted. Nuxt's chain (nitro → listhen → get-port-please) already
 * accepts `port: 0` — though it performs this same probe-and-release
 * internally (`getRandomPort`), so switching it is a simplification, not
 * a safety change. Next.js owns its listener and truly `listen(0)`s.
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
