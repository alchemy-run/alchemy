import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
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
  get(
    key: string,
  ): Effect.Effect<BlobObject | undefined, BlobContainerError, RuntimeContext>;
  /** Read a blob's properties; `undefined` when it does not exist. */
  head(
    key: string,
  ): Effect.Effect<
    BlobProperties | undefined,
    BlobContainerError,
    RuntimeContext
  >;
  /** List one page of blobs. */
  list(
    options?: ListBlobsOptions,
  ): Effect.Effect<ListBlobsResult, BlobContainerError, RuntimeContext>;
}

/**
 * Read access to an Azure Storage blob container from a Container App or
 * Function App.
 *
 * Binding grants the host's system-assigned managed identity
 * **Storage Blob Data Reader** on the container only, and registers the
 * account and container names as environment variables. At runtime the
 * client calls the Blob service over HTTPS with a managed-identity token.
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
