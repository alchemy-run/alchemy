/**
 * vinext data-cache adapter builder for Redis.
 *
 * Call from `vite.config.ts` — returns a serializable `{ adapter, options }`
 * descriptor. The runtime factory in `redis-runtime.ts` reads `REDIS_URL`
 * (or `urlEnv`) from `process.env` on the first request.
 *
 * ```ts
 * import { redisAdapter } from "@alchemy.run/frontend-frameworks/vinext/cache/redis";
 * import vinext from "vinext";
 *
 * export default defineConfig({
 *   plugins: [vinext({ cache: { data: redisAdapter() } })],
 * });
 * ```
 *
 * If `REDIS_URL` is missing (local `vinext start` / `alchemy dev`), vinext
 * logs and falls back to the in-memory handler.
 */
import { fileURLToPath } from "node:url";
import type { RedisAdapterOptions } from "./redis-runtime.ts";

export type { RedisAdapterOptions } from "./redis-runtime.ts";

export const DEFAULT_REDIS_URL_ENV = "REDIS_URL";

export const redisAdapter = (options?: RedisAdapterOptions) => {
  if (options?.urlEnv !== undefined && typeof options.urlEnv !== "string") {
    throw new TypeError(
      "[vinext] redisAdapter({ urlEnv }) must be a string env var name.",
    );
  }
  return {
    adapter: fileURLToPath(new URL("./redis-runtime.js", import.meta.url)),
    options,
  };
};
