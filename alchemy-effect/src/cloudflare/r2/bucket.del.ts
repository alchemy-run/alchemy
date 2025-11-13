import * as Effect from "effect/Effect";
import { getR2BucketFromEnv } from "./bucket.client.ts";
import type { Bucket } from "./bucket.ts";

export const del = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  keys: string | string[],
) {
  const client = yield* getR2BucketFromEnv(bucket);
  return yield* Effect.promise(() => client.delete(keys));
});
