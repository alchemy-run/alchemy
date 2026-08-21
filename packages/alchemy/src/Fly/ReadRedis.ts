import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Redis, RedisCommandError, RedisUrlMissing } from "./Redis.ts";

/**
 * Bind a {@link Redis} database with read access (`get`, `ping`).
 *
 * `ReadRedis` is the Context tag, the type, and the callable —
 * `yield* Fly.ReadRedis(Cache)`. Provide {@link ReadRedisHttp}.
 *
 *
 * ### Read
 * **Example:** Get a key
 * ```typescript
 * const cache = yield* Fly.ReadRedis(Cache);
 * const value = yield* cache.get("marker");
 * ```
 *
 * @binding
 */
export interface ReadRedis extends Binding.Service<
  ReadRedis,
  "Fly.ReadRedis",
  (redis: Redis) => Effect.Effect<ReadRedisClient>
> {}

export const ReadRedis = Binding.Service<ReadRedis>("Fly.ReadRedis");

export interface ReadRedisClient {
  get(
    key: string,
  ): Effect.Effect<
    string | null,
    RedisCommandError | RedisUrlMissing,
    RuntimeContext
  >;
  ping(): Effect.Effect<
    string,
    RedisCommandError | RedisUrlMissing,
    RuntimeContext
  >;
}
