import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";
import type { ReadBlobContainerClient } from "./BlobContainerRead.ts";
import type { WriteBlobContainerClient } from "./BlobContainerWrite.ts";

/** Read + write client for one blob container. */
export interface ReadWriteBlobContainerClient
  extends ReadBlobContainerClient, WriteBlobContainerClient {}

/**
 * Read and write access to an Azure Storage blob container from any host.
 *
 * Binding assigns **Storage Blob Data Contributor** on the container only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link BlobContainerReadWriteHttp}.
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
