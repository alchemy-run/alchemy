import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { getR2BucketFromEnv } from "./bucket.client.ts";
import type { Bucket } from "./bucket.ts";

export const list = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  options?: runtime.R2ListOptions,
) {
  const client = yield* getR2BucketFromEnv(bucket);
  return yield* Effect.promise(() => client.list(options));
});
