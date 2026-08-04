import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

export const isTransformTypesSupported = (
  version = process.versions.node,
): boolean => {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 7) || (major >= 23 && major < 26);
};

/**
 * Node CLI flags that transparently transform TypeScript types so `.ts`
 * entry points work the same way they do under Bun. Empty when the running
 * Node doesn't support (or no longer needs) the experimental flag.
 */
export const transformTypesFlags = (): string[] =>
  isTransformTypesSupported()
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];

/**
 * Ask the OS for an unused TCP port, release it, and return its number.
 *
 * The port is only available, not reserved: another process can claim it
 * before the caller binds. Callers should keep the gap short and still handle
 * `EADDRINUSE`.
 */
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
