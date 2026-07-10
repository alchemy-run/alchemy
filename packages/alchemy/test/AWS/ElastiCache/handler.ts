import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class ElastiCacheTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "ElastiCacheTestFunction",
) {}

export class FixtureCache extends Context.Service<
  FixtureCache,
  {
    cache: AWS.ElastiCache.ServerlessCache;
  }
>()("FixtureCache") {}

export const FixtureCacheLive = Layer.effect(
  FixtureCache,
  Effect.gen(function* () {
    // Valkey is the cheapest engine; usage limits are pinned to the service
    // minimums (1 GB storage, 1000 ECPUs/s) purely for cost control.
    const cache = yield* AWS.ElastiCache.ServerlessCache("FixtureCache", {
      engine: "valkey",
      description: "alchemy elasticache fixture",
      cacheUsageLimits: {
        dataStorage: { maximum: 1 },
        ecpuPerSecond: { maximum: 1000 },
      },
      tags: { fixture: "elasticache-serverless" },
    });
    return { cache };
  }),
);

/**
 * The function only exercises the env-only Connect binding shape: it is NOT
 * attached to the cache's VPC, so an actual valkey round-trip is impossible
 * here (and alchemy ships no redis client). `/connection` returns the
 * endpoint the binding resolved from the injected environment.
 */
export const ElastiCacheTestFunctionLive = ElastiCacheTestFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { cache } = yield* FixtureCache;
    const connection = yield* AWS.ElastiCache.Connect(cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/connection") {
          return yield* HttpServerResponse.json(yield* connection);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(AWS.ElastiCache.ConnectHttp, FixtureCacheLive),
    ),
  ),
  // Re-merge so the deploying Stack can `yield* FixtureCache` and expose the
  // cache attributes as deploy-time outputs. Reusing the same
  // `FixtureCacheLive` reference keeps it a single shared cache.
).pipe(Layer.provideMerge(FixtureCacheLive));

export default ElastiCacheTestFunctionLive;
