import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";
import type {
  BlobContainerError,
  BlobObject,
  BlobProperties,
  ListBlobsOptions,
  ListBlobsResult,
} from "./BlobContainerTypes.ts";

/** Read-only client for one blob container. */
export interface ReadBlobContainerClient {
  /** Download a blob; `undefined` when it does not exist. */
  get(key: string): Effect.Effect<BlobObject | undefined, BlobContainerError, RuntimeContext>;
  /** Read a blob's properties; `undefined` when it does not exist. */
  head(key: string): Effect.Effect<BlobProperties | undefined, BlobContainerError, RuntimeContext>;
  /** List one page of blobs. */
  list(
    options?: ListBlobsOptions,
  ): Effect.Effect<ListBlobsResult, BlobContainerError, RuntimeContext>;
}

/**
 * Read access to an Azure Storage blob container from any host.
 *
 * Binding assigns **Storage Blob Data Reader** on the container only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link BlobContainerReadHttp}.
 *
 * ### Reading Blobs
 * **Example:** Read a blob as text
 * ```typescript
 * // init
 * const files = yield* Azure.Storage.BlobContainerRead(container);
 *
 * // runtime
 * const blob = yield* files.get("reports/latest.json");
 * const report = blob ? JSON.parse(blob.text()) : undefined;
 * ```
 *
 * **Example:** List blobs under a prefix
 * ```typescript
 * const { blobs, nextMarker } = yield* files.list({ prefix: "reports/" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BlobContainerRead extends Binding.Service<
  BlobContainerRead,
  "Azure.Storage.BlobContainerRead",
  (container: BlobContainer) => Effect.Effect<ReadBlobContainerClient>
> {}

export const BlobContainerRead = Binding.Service<BlobContainerRead>(
  "Azure.Storage.BlobContainerRead",
);
