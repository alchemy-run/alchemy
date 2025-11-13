import * as Effect from "effect/Effect";
import { getR2BucketFromEnv } from "./bucket.client.ts";
import type { Bucket } from "./bucket.ts";

export const head = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  key: string,
) {
  const client = yield* getR2BucketFromEnv(bucket);
  return yield* Effect.promise(() => client.head(key));
});
