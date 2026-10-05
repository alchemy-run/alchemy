import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BlobContainer } from "./BlobContainer.ts";
import type { ReadBlobContainerClient } from "./BlobContainerRead.ts";
import type { WriteBlobContainerClient } from "./BlobContainerWrite.ts";

/** Read + write client for one blob container. */
export interface ReadWriteBlobContainerClient
  extends ReadBlobContainerClient, WriteBlobContainerClient {}

/**
 * Read and write access to an Azure Storage blob container from a Container
 * App or Function App.
 *
 * Binding grants the host's system-assigned managed identity
 * **Storage Blob Data Contributor** on the container only. Provide
 * {@link BlobContainerReadWriteHttp}.
 *
 * ### Reading and Writing Blobs
 * **Example:** Copy a blob
 * ```typescript
 * // init
 * const files = yield* Azure.Storage.BlobContainerReadWrite(container);
 *
 * // runtime
 * const blob = yield* files.get("in/data.csv");
 * if (blob) yield* files.put("out/data.csv", blob.body);
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BlobContainerReadWrite extends Binding.Service<
  BlobContainerReadWrite,
  "Azure.Storage.BlobContainerReadWrite",
  (container: BlobContainer) => Effect.Effect<ReadWriteBlobContainerClient>
> {}

export const BlobContainerReadWrite = Binding.Service<BlobContainerReadWrite>(
  "Azure.Storage.BlobContainerReadWrite",
);
