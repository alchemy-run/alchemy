import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { CommandError, UrlMissing } from "./Errors.ts";
import { command } from "./Protocol.ts";

/**
 * A Redis URL that resolves from the Function/Service environment at
 * runtime (`REDIS_URL`).
 */
export type Url = Effect.Effect<string, UrlMissing, RuntimeContext>;

/**
 * Read-only Redis client (`GET`, `PING`).
 */
export interface ReadClient {
  get(
    key: string,
  ): Effect.Effect<string | null, CommandError | UrlMissing, RuntimeContext>;
  ping(): Effect.Effect<string, CommandError | UrlMissing, RuntimeContext>;
}

/**
 * Write Redis client (`SET`, `DEL`).
 */
export interface WriteClient {
  set(
    key: string,
    value: string,
  ): Effect.Effect<void, CommandError | UrlMissing, RuntimeContext>;
  del(
    key: string,
  ): Effect.Effect<number, CommandError | UrlMissing, RuntimeContext>;
}

/**
 * Read + write Redis client.
 */
export interface ReadWriteClient extends ReadClient, WriteClient {}

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

/**
 * Read-only client over a runtime Redis URL.
 */
export const makeRead = (url: Url): ReadClient => ({
  get: (key) => command(url, "GET", [key]).pipe(Effect.map(asNullableString)),
  ping: () => command(url, "PING").pipe(Effect.map(asString)),
});

/**
 * Write client over a runtime Redis URL.
 */
export const makeWrite = (url: Url): WriteClient => ({
  set: (key, value) => command(url, "SET", [key, value]).pipe(Effect.asVoid),
  del: (key) => command(url, "DEL", [key]).pipe(Effect.map(asNumber)),
});

/**
 * Read + write client over a runtime Redis URL.
 *
 * Fly and Railway `*RedisHttp` layers pass this (or {@link makeRead} /
 * {@link makeWrite}) as `makeClient`. Tests can also drive RESP
 * directly via `command` / `run`.
 *
 * ```typescript
 * import * as Redis from "alchemy/Redis";
 *
 * const cache = Redis.makeReadWrite(url);
 * yield* cache.set("marker", "hello");
 * const value = yield* cache.get("marker");
 * ```
 */
export const makeReadWrite = (url: Url): ReadWriteClient => ({
  ...makeRead(url),
  ...makeWrite(url),
});
