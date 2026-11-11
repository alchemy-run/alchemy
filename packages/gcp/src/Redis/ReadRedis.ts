import type { ReadClient } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

// Clients' runtime effects require redis's `RuntimeContext` twin, so it shows
// up in users' inferred types. Exporting it here lets TypeScript name it
// through this package without users depending on @alchemy.run/redis.
export type { RuntimeContext as RedisRuntimeContext } from "@alchemy.run/redis/RuntimeContext";

/**
 * Bind a Memorystore {@link Instance} with read access.
 *
 * Uses the shared `@alchemy.run/redis` RESP client. Provide
 * {@link ReadRedisHttp}. The host receives only the instance endpoint; when
 * AUTH is enabled the runtime fetches the AUTH string with
 * `instances.getAuthString`, so the host is granted `roles/redis.admin`
 * (the only predefined role with that permission) on the project under an
 * IAM Condition matching this instance.
 *
 * ### Read
 * **Example:** Get a key
 * ```typescript
 * const cache = yield* GCP.Redis.ReadRedis(Memorystore);
 * const value = yield* cache.get("marker");
 * ```
 *
 * @binding
 * @category Redis
 */
export interface ReadRedis extends Binding.Service<
  ReadRedis,
  "GCP.Redis.ReadRedis",
  (instance: Instance) => Effect.Effect<ReadRedisClient>
> {}

export const ReadRedis = Binding.Service<ReadRedis>("GCP.Redis.ReadRedis");

export type ReadRedisClient = ReadClient;
