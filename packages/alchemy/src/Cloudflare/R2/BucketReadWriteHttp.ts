import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHttpBucketBinding, type R2HttpToken } from "./BucketHttp.ts";
import { makeReadR2HttpClient } from "./BucketReadHttp.ts";
import {
  BucketReadWrite,
  type ReadWriteBucketClient,
} from "./BucketReadWrite.ts";
import { makeWriteR2HttpClient } from "./BucketWriteHttp.ts";

/**
 * HTTP-backed implementation of the {@link BucketReadWrite} service.
 *
 * It creates a scoped {@link AccountApiToken} with the `Workers R2 Storage Read` and `Workers R2 Storage Write` permissions.
 */
export const ReadWriteBucketHttp = Layer.effect(
  BucketReadWrite,
  Effect.suspend(() =>
    makeHttpBucketBinding({
      permissionGroups: ["Workers R2 Storage Read", "Workers R2 Storage Write"],
      makeClient: makeReadWriteR2HttpClient,
    }),
  ),
);

/** Build the HTTP-backed {@link ReadWrite} over a bound token + bucket. */
export const makeReadWriteR2HttpClient = (
  token: R2HttpToken,
  bucketName: Effect.Effect<string>,
  jurisdiction: Effect.Effect<string>,
): ReadWriteBucketClient =>
  ({
    ...makeReadR2HttpClient(token, bucketName, jurisdiction),
    ...makeWriteR2HttpClient(token, bucketName, jurisdiction),
  }) satisfies ReadWriteBucketClient;
