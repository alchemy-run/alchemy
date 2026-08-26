import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReadClient } from "../../Redis/index.ts";
import type { Instance } from "./Instance.ts";

/**
 * Bind a Memorystore {@link Instance} with read access.
 *
 * Uses the shared `alchemy/Redis` RESP client. Provide
 * {@link ReadRedisHttp}. The instance's host/port/AUTH are packed into
 * `REDIS_URL` on the Cloud Run / Function host.
 *
 * ### Read
 * **Example:** Get a key
 * ```typescript
 * const cache = yield* GCP.Redis.ReadRedis(Memorystore);
 * const value = yield* cache.get("marker");
 * ```
 *
 * @binding
 * @product GCP
 * @category Redis
 */
export interface ReadRedis extends Binding.Service<
  ReadRedis,
  "GCP.Redis.ReadRedis",
  (instance: Instance) => Effect.Effect<ReadRedisClient>
> {}

export const ReadRedis = Binding.Service<ReadRedis>("GCP.Redis.ReadRedis");

export type ReadRedisClient = ReadClient;
