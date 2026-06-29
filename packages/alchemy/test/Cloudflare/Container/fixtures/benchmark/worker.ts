import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BenchBunObject } from "./bun-object.ts";
import { BenchEffectfulObject } from "./effectful-object.ts";
import { BenchRemoteObject } from "./remote-object.ts";

/**
 * Benchmark entrypoint. Each request names a fresh DO instance (`?name=`),
 * which boots its own container and reports the cold-start-to-reachable
 * latency measured inside the DO:
 *
 * - `GET /effectful?name=X` → effectful (bundled Effect program) container
 * - `GET /remote?name=X`    → remote (pre-built echo image) container
 * - `GET /bun?name=X`       → bun-baseline (same base image, no Effect bundle)
 *
 * The test fires N distinct names per route concurrently to spin up N
 * containers and compares the two variants.
 */
export default class BenchWorker extends Cloudflare.Worker<BenchWorker>()(
  "BenchWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const effectful = yield* BenchEffectfulObject;
    const remote = yield* BenchRemoteObject;
    const bun = yield* BenchBunObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const name = url.searchParams.get("name") ?? "default";

        if (url.pathname === "/effectful") {
          const result = yield* effectful.getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/remote") {
          const result = yield* remote.getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/bun") {
          const result = yield* bun.getByName(name).boot();
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catch((err) =>
          Effect.succeed(HttpServerResponse.text(String(err), { status: 500 })),
        ),
      ),
    };
  }),
) {}
