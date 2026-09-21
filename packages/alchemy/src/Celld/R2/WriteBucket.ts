import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  BucketValue,
  Conditional,
  R2Error,
  MultipartOptions,
  MultipartUpload,
  R2Object,
  PutOptions,
} from "./BucketTypes.ts";

export interface WriteBucket extends Binding.Service<
  WriteBucket,
  "Celld.R2.WriteBucket",
  (bucket: Bucket) => Effect.Effect<WriteBucketClient>
> {}

/**
 * Write objects to a Celld fleet bucket keyspace. There are no R2 event notifications.
 * Native access levels are TypeScript views, not authorization grants.
 * Streams need no contentLength. A conditional write too large for one native
 * request fails; it never silently drops its precondition. Multipart resume
 * is node-local and can fail after restart or on another node. Celld returns
 * empty part etags and completes uploads by part number.
 *
 * ### Store an object
 * **Example:** Write metadata in a Worker handler
 * ```typescript
 * const files = yield* Celld.R2.WriteBucket(bucket);
 * const fetch = Effect.gen(function* () {
 *   yield* files.put("hello.txt", "hello", {
 *     httpMetadata: { contentType: "text/plain" },
 *     customMetadata: { author: "example" },
 *   });
 *   return HttpServerResponse.text("stored");
 * });
 * ```
 * Provide `Celld.R2.WriteBucketBinding` on the Worker's initialization effect.
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export const WriteBucket = Binding.Service<WriteBucket>("Celld.R2.WriteBucket");

export interface WriteBucketClient {
  put<Err = never>(
    key: string,
    value: BucketValue | Stream.Stream<Uint8Array, Err>,
    options: PutOptions & { onlyIf: Conditional | Headers },
  ): Effect.Effect<R2Object | null, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value: BucketValue | Stream.Stream<Uint8Array, Err>,
    options?: Omit<PutOptions, "onlyIf"> & { onlyIf?: undefined },
  ): Effect.Effect<R2Object, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value: BucketValue | Stream.Stream<Uint8Array, Err>,
    options: PutOptions,
  ): Effect.Effect<R2Object | null, R2Error | Err, RuntimeContext>;
  delete(keys: string | string[]): Effect.Effect<void, R2Error, RuntimeContext>;
  createMultipartUpload(
    key: string,
    options?: MultipartOptions,
  ): Effect.Effect<MultipartUpload, R2Error, RuntimeContext>;
  /** A handle is returned immediately; invalid or lost uploads can fail on the first method call. */
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): Effect.Effect<MultipartUpload, R2Error, RuntimeContext>;
}
