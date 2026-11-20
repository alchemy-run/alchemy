import { type WriteClient, makeWrite } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Instance } from "./Instance.ts";
import { makeRedisBinding } from "./RedisBinding.ts";

/**
 * Bind a Memorystore {@link Instance} with write access.
 *
 * Uses the shared `@alchemy.run/redis` RESP client. Provide
 * {@link WriteRedisHttp}.
 *
 * @binding
 * @category Redis
 */
export interface WriteRedis extends Binding.Service<
  WriteRedis,
  "GCP.Redis.WriteRedis",
  (instance: Instance) => Effect.Effect<WriteRedisClient>
> {}

export const WriteRedis = Binding.Service<WriteRedis>("GCP.Redis.WriteRedis");

export type WriteRedisClient = WriteClient;

/**
 * HTTP/RESP implementation of {@link WriteRedis}.
 *
 * @layer
 * @provides GCP.Redis.WriteRedis
 */
export const WriteRedisHttp = Layer.effect(
  WriteRedis,
  makeRedisBinding({
    tag: "GCP.Redis.WriteRedis",
    makeClient: makeWrite,
  }),
);
