import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { R2Bucket } from "./Bucket.ts";
import type {
  R2Conditional,
  R2Error,
  R2MultipartOptions,
  R2MultipartUpload,
  R2Object,
  R2PutOptions,
} from "./BucketTypes.ts";

/**
 * @binding
 * @product R2
 * @category Storage & Databases
 */
export class BucketWrite extends Binding.Service<
  BucketWrite,
  (bucket: R2Bucket) => Effect.Effect<WriteBucketClient>
>()("Cloudflare.R2.BucketWrite") {}

export const WriteBucket = BucketWrite.bind;

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
    options?: R2PutOptions & {
      onlyIf: R2Conditional | Headers;
      contentLength?: number;
    },
  ): Effect.Effect<R2Object | null, R2Error | Err, RuntimeContext>;
  put<Err = never>(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob,
    options?: R2PutOptions,
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
    options: R2PutOptions & {
      contentLength: number;
    },
  ): Effect.Effect<R2Object, R2Error | Err, RuntimeContext>;
  delete(keys: string | string[]): Effect.Effect<void, R2Error, RuntimeContext>;
  createMultipartUpload(
    key: string,
    options?: R2MultipartOptions,
  ): Effect.Effect<R2MultipartUpload, R2Error, RuntimeContext>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): Effect.Effect<R2MultipartUpload, R2Error, RuntimeContext>;
}
