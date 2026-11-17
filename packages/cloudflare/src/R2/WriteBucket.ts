import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { BindingNameOptions } from "../Workers/WorkerBinding.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  Conditional,
  R2Error,
  MultipartOptions,
  MultipartUpload,
  R2Object,
  PutOptions,
} from "./BucketTypes.ts";

/**
 * Write R2 objects from an Effect-native Worker.
 *
 * The native binding is registered under the bucket's logical id by
 * default. Pass `{ binding: "MEDIA" }` to reuse a binding already declared
 * on the Worker's `env`; this does not register another name. The option
 * has no effect on HTTP/local clients.
 *
 * ### Using a declared Worker binding
 * **Example:** Write through an aliased R2 binding
 * ```typescript
 * // The host Worker declares env: { MEDIA: MyBucket }.
 * const media = yield* Cloudflare.R2.WriteBucket(MyBucket, { binding: "MEDIA" });
 * yield* media.put("message.txt", "hello");
 * ```
 *
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export interface WriteBucket extends Binding.Service<
  WriteBucket,
  "Cloudflare.R2.WriteBucket",
  (bucket: Bucket, options?: BindingNameOptions) => Effect.Effect<WriteBucketClient>
> {}

export const WriteBucket = Binding.Service<WriteBucket>("Cloudflare.R2.WriteBucket");

export interface WriteBucketClient {
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob
      | Stream.Stream<Uint8Array, Err>,
    options?: PutOptions & {
      onlyIf: Conditional | Headers;
      contentLength?: number;
    },
  ): Effect.Effect<R2Object | null, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: PutOptions,
  ): Effect.Effect<R2Object, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob
      | Stream.Stream<Uint8Array, Err>,
    options: PutOptions & {
      contentLength: number;
    },
  ): Effect.Effect<R2Object, R2Error | Err, RuntimeContext>;
  delete(keys: string | string[]): Effect.Effect<void, R2Error, RuntimeContext>;
  createMultipartUpload(
    key: string,
    options?: MultipartOptions,
  ): Effect.Effect<MultipartUpload, R2Error, RuntimeContext>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): Effect.Effect<MultipartUpload, R2Error, RuntimeContext>;
}
