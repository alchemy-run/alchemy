import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { BlobStore } from "./BlobStore.ts";
import type {
  BlobDeleteError,
  BlobPutError,
  PutBlobBody,
  PutBlobOptions,
  PutBlobResult,
} from "./BlobTypes.ts";

/**
 * Write-only runtime client for a {@link BlobStore} — put and delete.
 */
export interface WriteBlobClient {
  /**
   * Write a blob. `ifMatch` (CAS) and `allowOverwrite: false` (conditional
   * create) fail with the typed `BlobPreconditionFailed` /
   * `BlobAlreadyExists` respectively.
   */
  put(
    pathname: string,
    body: PutBlobBody,
    options?: PutBlobOptions,
  ): Effect.Effect<PutBlobResult, BlobPutError, RuntimeContext>;
  /** Delete one or more blobs by pathname (idempotent). */
  del(
    pathnames: string | readonly string[],
  ): Effect.Effect<void, BlobDeleteError, RuntimeContext>;
}

/**
 * Write access to a Vercel Blob store from inside a deployed Function —
 * the write half of the `ReadBlob`/`WriteBlob`/`ReadWriteBlob` split.
 *
 * Binding a store to a Function transparently connects the Function's
 * project to the store (the platform then injects the data-plane token
 * env), so there is nothing else to wire.
 *
 * Provide the implementation with `Effect.provide(Vercel.WriteBlobHttp)`.
 *
 * @binding
 * @section Writing Blobs
 * @example Write inside an Effect-native Function
 * ```typescript
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const uploads = yield* Vercel.WriteBlob(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const put = yield* uploads
 *           .put("hello.txt", "Hello, World!", { contentType: "text/plain" })
 *           .pipe(Effect.orDie);
 *         return yield* HttpServerResponse.json({ etag: put.etag });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Vercel.WriteBlobHttp)),
 * ) {}
 * ```
 *
 * @example Compare-and-swap with `ifMatch`
 * ```typescript
 * const updated = yield* uploads
 *   .put("state.json", JSON.stringify(next), { ifMatch: current.etag })
 *   .pipe(
 *     Effect.catchTag("Vercel.Blob.PreconditionFailed", () =>
 *       Effect.fail(new ConcurrentWrite()),
 *     ),
 *   );
 * ```
 *
 * @example Conditional create with `allowOverwrite: false`
 * ```typescript
 * yield* uploads.put("lock", "1", { allowOverwrite: false }).pipe(
 *   Effect.catchTag("Vercel.Blob.AlreadyExists", () => Effect.void),
 * );
 * ```
 */
export interface WriteBlob extends Binding.Service<
  WriteBlob,
  "Vercel.WriteBlob",
  (store: BlobStore) => Effect.Effect<WriteBlobClient>
> {}

export const WriteBlob = Binding.Service<WriteBlob>("Vercel.WriteBlob");
