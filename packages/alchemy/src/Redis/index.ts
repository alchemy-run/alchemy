/**
 * Cloud-agnostic Redis runtime client. Fly and Railway resources bind
 * `REDIS_URL`; this module speaks RESP over that URL. Import from
 * `alchemy/Redis`.
 *
 * Bindings stay on the cloud (`Fly.ReadWriteRedis`,
 * `Railway.ReadWriteRedis`). Those layers call {@link makeReadWrite}
 * so the RESP client is not duplicated.
 *
 * @example
 * ```typescript
 * import * as Redis from "alchemy/Redis";
 *
 * const cache = Redis.makeReadWrite(url);
 * yield* cache.set("marker", "hello");
 * const value = yield* cache.get("marker");
 * ```
 */
export * from "./Client.ts";
export * from "./Errors.ts";
export * from "./Protocol.ts";
