import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ReadWriteBucket } from "./ReadWriteBucket.ts";
import { makeReadBucketClient } from "./ReadBucketBinding.ts";
import { makeWriteBucketClient } from "./WriteBucketBinding.ts";
import { makeStorageBinding, storageHttpLayer } from "./StorageBinding.ts";

/**
 * One injected or managed credential for both interfaces.
 *
 * @layer
 * @provides ReadWriteBucket
 */
export const ReadWriteBucketBinding = Layer.effect(
  ReadWriteBucket,
  makeStorageBinding("binding", "storage:write").pipe(
    Effect.map((bind) =>
      Effect.fn(function* (...args: Parameters<typeof bind>) {
        const client = yield* bind(...args);
        return {
          ...makeReadBucketClient(client),
          ...makeWriteBucketClient(client),
        };
      }),
    ),
  ),
).pipe(Layer.provide(storageHttpLayer));
