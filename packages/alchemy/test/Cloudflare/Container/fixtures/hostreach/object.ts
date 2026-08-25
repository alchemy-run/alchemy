import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/**
 * Deterministic port the test's host-side HTTP server listens on. It stands
 * in for a local dev database (e.g. the `@prisma/dev` server) bound to the
 * developer machine's loopback — the container must be able to reach it even
 * though `localhost` inside the container is the container itself.
 */
export const HOST_PROBE_PORT = 42117;

/**
 * A literal local Prisma Postgres URL shape (`@prisma/dev` hands these out
 * in dev). Prisma's client only speaks plain HTTP to `prisma+postgres://`
 * hosts that look local (`localhost`/`127.0.0.1`/`[::1]`), so whatever the
 * dev runtime rewrites the host to must still contain "localhost".
 */
export const PPG_URL = "prisma+postgres://localhost:51216/?api_key=test-key";

class HostReachContainer extends Cloudflare.Container<HostReachContainer>()(
  "HostReachContainer",
  {
    // Template string, not `path.join(import.meta.dirname, …)`: this module is
    // bundled into the Worker and `import.meta.dirname` is undefined there.
    context: `${import.meta.dirname}/context`,
    env: {
      TARGET_URL: `http://localhost:${HOST_PROBE_PORT}/hello`,
      PPG_URL,
    },
    observability: { logs: { enabled: true } },
  },
) {}

/**
 * Durable Object that binds the {@link HostReachContainer} and exposes the
 * probe server's routes to the Worker.
 */
export class HostReachContainerObject extends Cloudflare.DurableObject<HostReachContainerObject>()(
  "HostReachContainerObject",
  Effect.gen(function* () {
    const container = yield* HostReachContainer;

    return Effect.gen(function* () {
      const { fetch } = yield* container.getTcpPort(8080);

      const get = (path: string) =>
        Effect.gen(function* () {
          const response = yield* fetch(
            HttpClientRequest.get(`http://container${path}`),
          );
          return yield* response.text;
        });

      return {
        getEnv: () => get("/env"),
        getProbe: () => get("/probe"),
        // The user pattern from #1334: forward the incoming request to the
        // container verbatim (`yield* fetch(yield* HttpServerRequest)`). In
        // production the incoming web Request carries an https:// URL that
        // workerd's container port rejects; dev serves http://, so rebuild
        // the request at the web layer with the scheme it would carry live.
        // (Only the underlying web Request's URL matters: the effect-level
        // `HttpServerRequest.url` is path-only and `toWeb` hands workerd the
        // original web Request.)
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const live = new Request(`https://container${request.url}`, {
            method: request.method,
          });
          return yield* fetch(HttpServerRequest.fromWeb(live));
        }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.Containers.layer(HostReachContainer, {
        enableInternet: true,
      }),
    ),
  ),
) {}
