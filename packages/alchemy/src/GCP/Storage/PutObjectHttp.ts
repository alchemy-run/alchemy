import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Bucket } from "./Bucket.ts";
import { grantOnBucket } from "./ObjectHttp.ts";
import { makeObjectMedia } from "./ObjectMedia.ts";
import { PutObject, type PutObjectRequest } from "./PutObject.ts";

/**
 * HTTP implementation of {@link PutObject}.
 *
 * @layer
 * @provides GCP.Storage.PutObject
 */
export const PutObjectHttp = Layer.effect(
  PutObject,
  Effect.gen(function* () {
    const media = yield* makeObjectMedia;
    return Effect.fn(function* (bucket: Bucket) {
      yield* grantOnBucket(
        "GCP.Storage.PutObject",
        bucket,
        "roles/storage.objectUser",
      );
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`GCP.Storage.PutObject(${bucket.LogicalId})`)(function* (
        request: PutObjectRequest,
      ) {
        return yield* media.upload(yield* bucketName, request);
      });
    });
  }),
);
