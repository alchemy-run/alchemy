import * as Railway from "@/Railway";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { canPushRailwayImage, railwayRegistry } from "./registry.ts";
import { Cache, REDIS_KEY, REDIS_VALUE, Site } from "./redis-shared.ts";

export { Cache, REDIS_KEY, REDIS_VALUE, Site };

export const REDIS_PORT = 3000;

/**
 * HTTP Service that PINGs Redis and round-trips a key via
 * {@link Railway.ReadWriteRedis}.
 *
 * When `RAILWAY_REGISTRY` is unset, docker push is impossible: Railway
 * runs `hashicorp/http-echo` for HTTP health. Tests set/get over TcpProxy.
 */
export default class RedisApi extends Railway.Service<RedisApi>()(
  "RedisApi",
  Effect.gen(function* () {
    if (canPushRailwayImage) {
      return {
        project: Site,
        main: import.meta.url,
        registry: railwayRegistry,
        port: REDIS_PORT,
      };
    }
    return {
      project: Site,
      image: "hashicorp/http-echo",
      port: 5678,
    };
  }),
  Effect.gen(function* () {
    const cache = yield* Railway.ReadWriteRedis(Cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;

        if (path === "/health" || path === "/") {
          const pong = yield* cache.ping().pipe(
            Effect.map((body) => /pong/i.test(body)),
            Effect.orElseSucceed(() => false),
          );
          return yield* HttpServerResponse.json({ pong });
        }

        if (path === "/set") {
          yield* cache.set(REDIS_KEY, REDIS_VALUE);
          return yield* HttpServerResponse.json({ ok: true, key: REDIS_KEY });
        }

        if (path === "/get") {
          const value = yield* cache.get(REDIS_KEY);
          return yield* HttpServerResponse.json({
            ok: value === REDIS_VALUE,
            value,
          });
        }

        return yield* HttpServerResponse.json({ ok: false }, { status: 404 });
      }).pipe(
        Effect.catch((error) =>
          HttpServerResponse.json(
            { ok: false, error: String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Railway.ReadWriteRedisHttp)),
) {}
