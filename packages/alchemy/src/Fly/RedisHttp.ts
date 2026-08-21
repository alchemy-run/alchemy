import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ReadRedisClient } from "./ReadRedis.ts";
import type { ReadWriteRedisClient } from "./ReadWriteRedis.ts";
import type { RedisUrlMissing } from "./Redis.ts";
import { redisCommand } from "./RedisBinding.ts";
import type { WriteRedisClient } from "./WriteRedis.ts";

/**
 * Shared Redis command-client builders. NOT exported from `index.ts`.
 */

const asString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
};

const asNullableString = (value: unknown): string | null => {
  if (value == null) return null;
  return asString(value);
};

const asNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(asString(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const makeReadRedisClient = (
  url: Effect.Effect<string, RedisUrlMissing, RuntimeContext>,
): ReadRedisClient => ({
  get: (key) =>
    redisCommand(url, "GET", [key]).pipe(Effect.map(asNullableString)),
  ping: () => redisCommand(url, "PING").pipe(Effect.map(asString)),
});

export const makeWriteRedisClient = (
  url: Effect.Effect<string, RedisUrlMissing, RuntimeContext>,
): WriteRedisClient => ({
  set: (key, value) =>
    redisCommand(url, "SET", [key, value]).pipe(Effect.asVoid),
  del: (key) => redisCommand(url, "DEL", [key]).pipe(Effect.map(asNumber)),
});

export const makeReadWriteRedisClient = (
  url: Effect.Effect<string, RedisUrlMissing, RuntimeContext>,
): ReadWriteRedisClient => ({
  ...makeReadRedisClient(url),
  ...makeWriteRedisClient(url),
});
