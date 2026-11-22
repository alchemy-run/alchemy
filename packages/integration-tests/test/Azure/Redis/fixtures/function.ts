import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { accepted } from "../../arm-action-fixture.ts";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/** The cheapest cache (Basic C0): flushed. */
export const Cache = Azure.Redis.Cache("RedisBindingsCache", { sku: "Basic", capacity: 0 });

/**
 * Effect-native Azure Function exercising the Azure Cache for Redis flush
 * binding on a managed-identity host. Export and import need a Premium
 * cache; their requests are covered by the ungated probes.
 */
export default class RedisFunction extends Azure.Functions.Function<RedisFunction>()(
  "RedisFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const cache = yield* Cache;
    const flushCache = yield* Azure.Redis.FlushCache(cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        switch (new URL(request.url, "http://localhost").pathname) {
          case "/flush":
            return yield* accepted(flushCache());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(Azure.Redis.FlushCacheHttp)),
) {}
