import type { ReadClient } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

// TODO(typescript>7.1.0): TypeScript 7.1 reports TS2883 in apps that bind
// Redis (an inferred type "cannot be named without a reference to
// 'RuntimeContext'" from @alchemy.run/redis), which 7.0 accepted. The
// clients' runtime effects require redis's `RuntimeContext` twin, and this
// re-export lets TypeScript name it through this package. To test, remove
// it and check that `pnpm exec tsrs -b examples/fly-redis
// examples/gcp-memorystore-redis examples/railway-service` passes; keep it
// if it still helps published `.d.ts` consumers.
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
