import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { BlobStore } from "./BlobStore.ts";
import type {
  BlobListError,
  BlobObject,
  BlobReadError,
  GetBlobResult,
  ListBlobsOptions,
  ListBlobsResult,
} from "./BlobTypes.ts";

/**
 * Read-only runtime client for a {@link BlobStore} — head, get, and list.
 */
export interface ReadBlobClient {
  /** Fetch a blob's metadata; fails with the typed `BlobNotFound` when missing. */
  head(
    pathname: string,
  ): Effect.Effect<BlobObject, BlobReadError, RuntimeContext>;
  /** Fetch a blob's content (buffered); fails with `BlobNotFound` when missing. */
  get(
    pathname: string,
  ): Effect.Effect<GetBlobResult, BlobReadError, RuntimeContext>;
  /** List one page of blobs. */
  list(
    options?: ListBlobsOptions,
  ): Effect.Effect<ListBlobsResult, BlobListError, RuntimeContext>;
}

/**
 * Read access to a Vercel Blob store from inside a deployed Function —
 * the least-privilege half of the `ReadBlob`/`WriteBlob`/`ReadWriteBlob`
 * split. The client exposes only `head`/`get`/`list`; write operations are
 * not present on the type.
 *
 * Binding a store to a Function transparently connects the Function's
 * project to the store (the platform then injects the data-plane token
 * env), so there is nothing else to wire.
 *
 * Provide the implementation with `Effect.provide(Vercel.ReadBlobHttp)`.
 *
 * @binding
 * @section Reading Blobs
 * @example Read inside an Effect-native Function
 * ```typescript
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const uploads = yield* Vercel.ReadBlob(Uploads);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const blob = yield* uploads.get("hello.txt").pipe(Effect.orDie);
 *         return yield* HttpServerResponse.text(yield* blob.text);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Vercel.ReadBlobHttp)),
 * ) {}
 * ```
 *
 * @example Handle a missing blob with the typed tag
 * ```typescript
 * const body = yield* uploads.get("maybe.txt").pipe(
 *   Effect.flatMap((blob) => blob.text),
 *   Effect.catchTag("Vercel.Blob.NotFound", () => Effect.succeed("")),
 * );
 * ```
 */
export interface ReadBlob extends Binding.Service<
  ReadBlob,
  "Vercel.ReadBlob",
  (store: BlobStore) => Effect.Effect<ReadBlobClient>
> {}

export const ReadBlob = Binding.Service<ReadBlob>("Vercel.ReadBlob");
