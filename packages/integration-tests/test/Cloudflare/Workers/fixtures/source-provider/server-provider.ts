import * as crypto from "node:crypto";
import * as Http from "node:http";
import type { SourceProvider, WorkerSourceModule } from "@alchemy.run/cloudflare/Workers/Source";
import type * as Bundle from "alchemy/Bundle/Bundle";
import * as Effect from "effect/Effect";

/**
 * Server-mode external source fixture: `dev()` runs its own HTTP server and
 * hands the host its URL, like a framework dev server (`next dev`). It
 * deliberately does not set `serviceBinding`, so nothing registers under the
 * Worker's name — the local edge router has no way to reach it, and a request
 * only succeeds if the Worker's proxy points straight at this server.
 */
const make: WorkerSourceModule["make"] = () =>
  Effect.sync((): SourceProvider => {
    const content = "export default { fetch: () => new Response('built') };";
    const bundle = Effect.sync((): Bundle.BundleOutput => {
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      return { files: [{ path: "main.js", content, hash }], hash };
    });
    return {
      ownsAssets: false,
      build: () =>
        bundle.pipe(
          Effect.map((output) => ({
            bundle: output,
            assets: undefined,
            hash: {
              bundle: output.hash,
              assets: undefined,
              input: undefined,
              additionalWorkspaces: undefined,
            },
          })),
        ),
      hash: () => bundle.pipe(Effect.map((output) => ({ bundle: output.hash }))),
      dev: () =>
        Effect.acquireRelease(
          Effect.callback<Http.Server>((resume) => {
            const server = Http.createServer((request, response) => {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  worker: "source-server",
                  url: request.url,
                  host: request.headers.host,
                }),
              );
            });
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
          }),
          (server) =>
            Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
        ).pipe(
          Effect.map((server) => ({
            mode: "server" as const,
            url: new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
          })),
        ),
    };
  });

export default { make } satisfies WorkerSourceModule;
