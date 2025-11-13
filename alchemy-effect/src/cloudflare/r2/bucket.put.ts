import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { replaceEffectStream } from "../stream.ts";
import { getR2BucketFromEnv, type UploadValue } from "./bucket.client.ts";
import type { Bucket } from "./bucket.ts";

export const put = Effect.fnUntraced(function* <B extends Bucket>(
  bucket: B,
  key: string,
  value: UploadValue,
  options?: runtime.R2PutOptions,
) {
  const client = yield* getR2BucketFromEnv(bucket);
  return yield* Effect.promise(() =>
    client.put(key, replaceEffectStream(value), options),
  );
});
