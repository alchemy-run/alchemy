import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetBlobExpiry` request without the `url` and `containerName` the bound container supplies. */
export interface SetBlobExpiryRequest extends Omit<
  blob.SetBlobExpiryRequest,
  "url" | "containerName"
> {}

/**
 * Set when a blob expires and is deleted (`Set Blob Expiry`). Azure supports
 * it only on accounts with a hierarchical namespace (Data Lake Storage).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetBlobExpiryHttp}.
 *
 * ### Expiring Blobs
 * **Example:** Delete a blob in one hour
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
 *     const setBlobExpiry = yield* Azure.Storage.SetBlobExpiry(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setBlobExpiry({ blob: "tmp/upload.bin", xMsExpiryOption: "RelativeToNow", xMsExpiryTime: "3600000" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetBlobExpiryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetBlobExpiry extends Binding.Service<
  SetBlobExpiry,
  "Azure.Storage.SetBlobExpiry",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetBlobExpiryRequest,
    ) => Effect.Effect<blob.SetBlobExpiryResponse, blob.SetBlobExpiryError, RuntimeContext>
  >
> {}

export const SetBlobExpiry = Binding.Service<SetBlobExpiry>("Azure.Storage.SetBlobExpiry");
