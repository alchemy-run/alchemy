import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeBucketBinding, makeHelpers } from "./BucketBinding.ts";
import { makeRead } from "./BucketReadBinding.ts";
import {
  BucketReadWrite,
  type ReadWriteBucketClient,
} from "./BucketReadWrite.ts";
import { makeWrite } from "./BucketWriteBinding.ts";

/**
 * Implementation of the {@link BucketReadWrite} service that uses a Worker binding.
 */
export const ReadWriteBucketBinding = Layer.effect(
  BucketReadWrite,
  Effect.suspend(() => makeBucketBinding({ makeClient: makeReadWrite })),
);

/** Build the read-write binding client from its read and write halves. */
export const makeReadWrite = (
  helpers: ReturnType<typeof makeHelpers>,
): ReadWriteBucketClient =>
  ({
    ...makeRead(helpers),
    ...makeWrite(helpers),
  }) satisfies ReadWriteBucketClient;
