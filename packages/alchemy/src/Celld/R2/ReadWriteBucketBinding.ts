import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeR2BucketBinding, makeR2BucketHelpers } from "./BucketBinding.ts";
import { makeReadBucketClient } from "./ReadBucketBinding.ts";
import {
  ReadWriteBucket,
  type ReadWriteBucketClient,
} from "./ReadWriteBucket.ts";
import { makeWriteBucketClient } from "./WriteBucketBinding.ts";

/**
 * Native Celld R2 reads and writes. No operator credentials are exposed to the Worker.
 *
 * @layer
 * @provides Celld.R2.ReadWriteBucket
 * @product R2
 */
export const ReadWriteBucketBinding = Layer.effect(
  ReadWriteBucket,
  Effect.suspend(() =>
    makeR2BucketBinding({ makeClient: makeReadWriteBucketClient }),
  ),
);

/** Build the read-write binding client from its read and write halves. */
export const makeReadWriteBucketClient = (
  helpers: ReturnType<typeof makeR2BucketHelpers>,
): ReadWriteBucketClient =>
  ({
    ...makeReadBucketClient(helpers),
    ...makeWriteBucketClient(helpers),
  }) satisfies ReadWriteBucketClient;
