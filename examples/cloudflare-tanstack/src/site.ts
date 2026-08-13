// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module joins the TanStack Start vite graph (the generated worker
// entry imports it), and in dev the vite module runner evaluates every
// module in that graph. The provider barrel would drag the entire IaC
// engine into it — the service-level subpaths keep it to the construct +
// capability slice.
import * as R2 from "alchemy/Cloudflare/R2";
import * as Website from "alchemy/Cloudflare/Website";
import { passthrough } from "alchemy/serve";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * R2 bucket bound by the site's Effect program. Registered on the stack
 * when the program's init Effect runs at plan time — no separate wiring in
 * alchemy.run.ts needed.
 */
export const Bucket = R2.Bucket("Bucket");

/**
 * ONE Worker serves the TanStack Start app AND an Effect-native API: the
 * third argument is an Effect program (the same shape as
 * `Cloudflare.Worker`) whose `fetch` owns `/api/*` (the default
 * `server.routes`). The R2 capability the program uses is collected
 * automatically at plan time — no separate backend worker, service
 * binding, proxy route, or env shim.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated worker entry re-imports
 * it inside the vite graph.
 */
export default class Site extends Website.Vite<Site>()(
  "Website",
  {
    main: import.meta.url,
    compatibility: {
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    // Init: runs at plan time in the engine (collects the R2 binding) and
    // again inside the Worker on first request (builds the runtime client).
    const bucket = yield* R2.ReadWriteBucket(Bucket);
    return {
      // GET/PUT /api/hello?key=<key> — reads/writes R2 through the typed
      // binding. Everything else under /api/* falls through to TanStack
      // Start via the typed `passthrough`.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://site");
        if (url.pathname !== "/api/hello") {
          return yield* passthrough;
        }
        const key = url.searchParams.get("key");
        if (!key) {
          return HttpServerResponse.text("Missing 'key' query parameter", {
            status: 400,
          });
        }

        if (request.method === "GET") {
          const object = yield* bucket.get(key);
          if (object === null) {
            return HttpServerResponse.text("Not found", { status: 404 });
          }
          return HttpServerResponse.stream(object.body);
        }

        if (request.method === "PUT") {
          yield* bucket.put(key, request.stream, {
            contentLength: Number(request.headers["content-length"] ?? 0),
          });
          return HttpServerResponse.empty({ status: 204 });
        }

        return HttpServerResponse.text("Method not allowed", { status: 405 });
      }).pipe(
        Effect.catchTag("R2Error", (error) =>
          Effect.succeed(
            HttpServerResponse.text(error.message, { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(R2.ReadWriteBucketBinding)),
) {}
