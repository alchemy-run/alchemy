import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BlobStore } from "./BlobStore.ts";
import type { ReadBlobClient } from "./ReadBlob.ts";
import type { WriteBlobClient } from "./WriteBlob.ts";

/**
 * Full-access runtime client for a {@link BlobStore} — the union of
 * {@link ReadBlobClient} and {@link WriteBlobClient}.
 */
export interface ReadWriteBlobClient extends ReadBlobClient, WriteBlobClient {}

/**
 * Read + write access to a Vercel Blob store from inside a deployed
 * Function. Binding a store to a Function transparently connects the
 * Function's project to the store — the platform then injects the
 * `BLOB_READ_WRITE_TOKEN` data-plane env var the client authenticates
 * with — so there is nothing else to wire.
 *
 * Provide the implementation with `Effect.provide(Vercel.ReadWriteBlobHttp)`.
 *
 * @binding
 * @section Reading and Writing Blobs
 * @example Round-trip inside an Effect-native Function
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Uploads = Vercel.BlobStore("Uploads");
 *
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const uploads = yield* Vercel.ReadWriteBlob(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const put = yield* uploads
 *           .put("greeting.txt", "Hello!", { contentType: "text/plain" })
 *           .pipe(Effect.orDie);
 *         const blob = yield* uploads.get("greeting.txt").pipe(Effect.orDie);
 *         return yield* HttpServerResponse.json({
 *           etag: put.etag,
 *           text: yield* blob.text,
 *         });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Vercel.ReadWriteBlobHttp)),
 * ) {}
 * ```
 *
 * @section Least Privilege
 * @example Split access with `ReadBlob` / `WriteBlob`
 * When a Function only reads (or only writes), bind the narrower service —
 * the client type simply has no write (or read) methods.
 * ```typescript
 * const reader = yield* Vercel.ReadBlob(Uploads);   // head / get / list only
 * const writer = yield* Vercel.WriteBlob(Uploads);  // put / del only
 * ```
 */
export interface ReadWriteBlob extends Binding.Service<
  ReadWriteBlob,
  "Vercel.ReadWriteBlob",
  (store: BlobStore) => Effect.Effect<ReadWriteBlobClient>
> {}

export const ReadWriteBlob = Binding.Service<ReadWriteBlob>(
  "Vercel.ReadWriteBlob",
);
