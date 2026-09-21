import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";
import type { ReadBucketClient } from "./ReadBucket.ts";
import type { WriteBucketClient } from "./WriteBucket.ts";

export interface ReadWriteBucket extends Binding.Service<
  ReadWriteBucket,
  "Celld.R2.ReadWriteBucket",
  (bucket: Bucket) => Effect.Effect<ReadWriteBucketClient>
> {}

/**
 * Read and write objects in the fleet bucket's keyspace through a native binding.
 * This is not a separate cloud bucket or a token-scoped authorization boundary.
 * Celld 0.5 has no R2 event notifications; multipart handles can be lost on restart.
 *
 * ### Read after writing
 * **Example:** Use the combined client in a Worker handler
 * ```typescript
 * const files = yield* Celld.R2.ReadWriteBucket(bucket);
 * const fetch = Effect.gen(function* () {
 *   yield* files.put("hello.txt", "hello");
 *   const object = yield* files.get("hello.txt");
 *   return HttpServerResponse.text(object ? yield* object.text() : "missing");
 * });
 * ```
 * Provide `Celld.R2.ReadWriteBucketBinding` on the Worker's initialization effect.
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export const ReadWriteBucket = Binding.Service<ReadWriteBucket>(
  "Celld.R2.ReadWriteBucket",
);

export interface ReadWriteBucketClient
  extends ReadBucketClient, WriteBucketClient {}
