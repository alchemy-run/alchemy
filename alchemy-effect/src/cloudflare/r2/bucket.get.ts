import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { getR2BucketFromEnv } from "./bucket.client.ts";
import type { Bucket } from "./bucket.ts";

export const get = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  key: string,
  options?: runtime.R2GetOptions,
) {
  const client = yield* getR2BucketFromEnv(bucket);
  return yield* Effect.promise(() => client.get(key, options));
});
