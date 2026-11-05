import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { API_PORT, Cache } from "./shared.ts";

// TODO(typescript>7.1.0): TypeScript 7.1 reports TS2883 on `Api` (its
// inferred type "cannot be named without a reference to 'RuntimeContext'"
// from @alchemy.run/redis) unless this example depends on @alchemy.run/redis
// directly, so it was added to package.json. To revert, remove that
// dependency, `pnpm install`, and check that `pnpm exec tsrs -b` passes this
// file.
/**
 * HTTP Service that PINGs Upstash Redis via {@link Fly.ReadRedis}.
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const cache = yield* Fly.ReadRedis(Cache);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        const pong = yield* cache.ping().pipe(
          Effect.map((body) => /pong/i.test(body)),
          Effect.orElseSucceed(() => false),
        );
        if (path === "/health") {
          return yield* HttpServerResponse.json({ ok: pong });
        }
        return yield* HttpServerResponse.json({ pong });
      }),
    };
  }).pipe(Effect.provide(Fly.ReadRedisHttp)),
) {}
