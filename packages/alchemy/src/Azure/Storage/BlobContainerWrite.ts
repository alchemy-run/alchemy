import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { BlobContainer } from "./BlobContainer.ts";
import type {
  BlobContainerError,
  PutBlobOptions,
} from "./BlobContainerTypes.ts";

/** Write-only client for one blob container. */
export interface WriteBlobContainerClient {
  /** Upload (create or overwrite) a block blob. */
  put(
    key: string,
    body: string | Uint8Array,
    options?: PutBlobOptions,
  ): Effect.Effect<
    { etag: string | undefined },
    BlobContainerError,
    RuntimeContext
  >;
  /** Delete a blob; succeeds when it is already gone. */
  delete(key: string): Effect.Effect<void, BlobContainerError, RuntimeContext>;
}

/**
 * Write access to an Azure Storage blob container from a Container App or
 * Function App.
 *
 * Binding grants the host's system-assigned managed identity
 * **Storage Blob Data Contributor** on the container only (Azure has no
 * write-only blob role). Provide {@link BlobContainerWriteHttp}.
 *
 * ### Writing Blobs
 * **Example:** Upload JSON
 * ```typescript
 * // init
 * const files = yield* Azure.Storage.BlobContainerWrite(container);
 *
 * // runtime
 * yield* files.put("reports/latest.json", JSON.stringify(report), {
 *   contentType: "application/json",
 * });
 * ```
 *
 * **Example:** Delete a blob
 * ```typescript
 * yield* files.delete("reports/stale.json");
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BlobContainerWrite extends Binding.Service<
  BlobContainerWrite,
  "Azure.Storage.BlobContainerWrite",
  (container: BlobContainer) => Effect.Effect<WriteBlobContainerClient>
> {}

export const BlobContainerWrite = Binding.Service<BlobContainerWrite>(
  "Azure.Storage.BlobContainerWrite",
);
