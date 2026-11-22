import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `CopyPageBlobIncremental` request without the `url` and `containerName` the bound container supplies. */
export interface CopyPageBlobIncrementalRequest extends Omit<
  blob.CopyPageBlobIncrementalRequest,
  "url" | "containerName"
> {}

/**
 * Copy the pages that changed since the last incremental copy from a page
 * blob snapshot (`Incremental Copy Blob`). The source snapshot URL must be
 * public or carry a SAS.
 *
 * Binding grants a custom role with only `blobs/write` (Azure reads the
 * source with the URL's own authorization: public, a SAS, or
 * `xMsCopySourceAuthorization`), assigned on the bound container only. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role
 * goes to that identity; any other host gets an Entra service principal with
 * the role and its client secret in the host's env (see `AzureBindings`).
 * The custom role is an `Azure.Authorization.RoleDefinition` created once
 * per stack and shared by every host. Provide {@link
 * CopyPageBlobIncrementalHttp}.
 *
 * ### Incremental Copies
 * **Example:** Copy a page blob snapshot
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *     const files = yield* Azure.Storage.BlobContainer("Files", {
 *       storageAccount: account.storageAccountName,
 *     });
 *
 *     // init: bind the operation to the container
 *     const copyPageBlobIncremental = yield* Azure.Storage.CopyPageBlobIncremental(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* copyPageBlobIncremental({ blob: "backup.vhd", xMsCopySource: `${sourceUrl}?snapshot=${snapshot}` });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.CopyPageBlobIncrementalHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CopyPageBlobIncremental extends Binding.Service<
  CopyPageBlobIncremental,
  "Azure.Storage.CopyPageBlobIncremental",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: CopyPageBlobIncrementalRequest,
    ) => Effect.Effect<
      blob.CopyPageBlobIncrementalResponse,
      blob.CopyPageBlobIncrementalError,
      RuntimeContext
    >
  >
> {}

export const CopyPageBlobIncremental = Binding.Service<CopyPageBlobIncremental>(
  "Azure.Storage.CopyPageBlobIncremental",
);
