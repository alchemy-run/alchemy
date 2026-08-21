import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Redis, RedisCommandError, RedisUrlMissing } from "./Redis.ts";

/**
 * Bind a {@link Redis} database with write access (`set`, `del`).
 *
 * `WriteRedis` is the Context tag, the type, and the callable —
 * `yield* Railway.WriteRedis(Cache)`. Provide {@link WriteRedisHttp}.
 *
 * @binding
 *
 * @section Write
 * @example Set a key
 * ```typescript
 * const cache = yield* Railway.WriteRedis(Cache);
 * yield* cache.set("marker", "hello");
 * ```
 */
export interface WriteRedis extends Binding.Service<
  WriteRedis,
  "Railway.WriteRedis",
  (redis: Redis) => Effect.Effect<WriteRedisClient>
> {}

export const WriteRedis = Binding.Service<WriteRedis>("Railway.WriteRedis");

export interface WriteRedisClient {
  set(
    key: string,
    value: string,
  ): Effect.Effect<void, RedisCommandError | RedisUrlMissing, RuntimeContext>;
  del(
    key: string,
  ): Effect.Effect<number, RedisCommandError | RedisUrlMissing, RuntimeContext>;
}
