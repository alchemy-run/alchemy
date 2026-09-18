import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WriteBucket } from "./WriteBucket.ts";
import { makeWriteBucketClient } from "./WriteBucketBinding.ts";
import { makeStorageBinding, storageHttpLayer } from "./StorageBinding.ts";

/**
 * Managed storage:read and storage:write credentials on supported runtime hosts.
 *
 * @layer
 * @provides WriteBucket
 */
export const WriteBucketHttp = Layer.effect(
  WriteBucket,
  makeStorageBinding("http", "storage:write").pipe(
    Effect.map((bind) =>
      Effect.fn(function* (...args: Parameters<typeof bind>) {
        return makeWriteBucketClient(yield* bind(...args));
      }),
    ),
  ),
).pipe(Layer.provide(storageHttpLayer));
