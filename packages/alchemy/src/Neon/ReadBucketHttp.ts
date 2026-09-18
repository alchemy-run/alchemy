import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReadBucket } from "./ReadBucket.ts";
import { makeReadBucketClient } from "./ReadBucketBinding.ts";
import { makeStorageBinding, storageHttpLayer } from "./StorageBinding.ts";

/**
 * Managed storage:read credentials for Workers, Lambda, local and cross-branch Functions.
 *
 * @layer
 * @provides ReadBucket
 */
export const ReadBucketHttp = Layer.effect(
  ReadBucket,
  makeStorageBinding("http", "storage:read").pipe(
    Effect.map((bind) =>
      Effect.fn(function* (...args: Parameters<typeof bind>) {
        return makeReadBucketClient(yield* bind(...args));
      }),
    ),
  ),
).pipe(Layer.provide(storageHttpLayer));
