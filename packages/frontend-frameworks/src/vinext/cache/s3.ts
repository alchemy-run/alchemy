/**
 * vinext data-cache adapter builder for S3.
 *
 * Call from `vite.config.ts` — returns a serializable `{ adapter, options }`
 * descriptor. The runtime factory reads `CACHE_BUCKET_NAME` from the
 * Lambda environment (Alchemy's `AWS.Website.Vinext` sets it).
 *
 * ```ts
 * import { s3Adapter } from "@alchemy.run/frontend-frameworks/vinext/cache/s3";
 * import vinext from "vinext";
 *
 * export default defineConfig({
 *   plugins: [vinext({ cache: { data: s3Adapter() } })],
 * });
 * ```
 *
 * If the bucket env is missing (local `vinext start`), vinext logs and
 * falls back to the in-memory handler.
 */
import { fileURLToPath } from "node:url";
import type { S3AdapterOptions } from "./s3-runtime.ts";

export type { S3AdapterOptions } from "./s3-runtime.ts";

export const DEFAULT_CACHE_BUCKET_ENV = "CACHE_BUCKET_NAME";
export const DEFAULT_CACHE_PREFIX = "vinext-cache/";

export const s3Adapter = (options?: S3AdapterOptions) => {
  if (
    options?.bucketEnv !== undefined &&
    typeof options.bucketEnv !== "string"
  ) {
    throw new TypeError(
      "[vinext] s3Adapter({ bucketEnv }) must be a string env var name.",
    );
  }
  return {
    adapter: fileURLToPath(new URL("./s3-runtime.js", import.meta.url)),
    options,
  };
};
