import * as Layer from "effect/Layer";
import { makeBucketHttpBinding } from "./BindingHttp.ts";
import { makeReadBucketClient } from "./ReadBucketHttp.ts";
import { ReadWriteBucket } from "./ReadWriteBucket.ts";
import { makeWriteBucketClient } from "./WriteBucketHttp.ts";

/**
 * S3 implementation of {@link ReadWriteBucket}.
 *
 * @layer
 * @provides Stackit.ObjectStorage.ReadWriteBucket
 */
export const ReadWriteBucketHttp = Layer.effect(
  ReadWriteBucket,
  makeBucketHttpBinding({
    tag: "Stackit.ObjectStorage.ReadWriteBucket",
    level: "ReadWrite",
    makeClient: (bucket) => ({
      ...makeReadBucketClient(bucket),
      ...makeWriteBucketClient(bucket),
    }),
  }),
);
