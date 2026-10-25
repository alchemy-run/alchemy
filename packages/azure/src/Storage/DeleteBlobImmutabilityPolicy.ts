import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `DeleteBlobImmutabilityPolicy` request without the `url` and `containerName` the bound container supplies. */
export interface DeleteBlobImmutabilityPolicyRequest extends Omit<
  blob.DeleteBlobImmutabilityPolicyRequest,
  "url" | "containerName"
> {}

/**
 * Delete an unlocked immutability policy from a blob (`Delete Blob
 * Immutability Policy`).
 *
 * Binding grants a custom role with only
 * `blobs/immutableStorage/runAsSuperUser/action`, assigned on the bound
 * container only. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host gets an Entra
 * service principal with the role and its client secret in the host's env
 * (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link DeleteBlobImmutabilityPolicyHttp}.
 *
 * ### Removing Immutability Policies
 * **Example:** Remove a blob's policy
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
 *     const deleteBlobImmutabilityPolicy = yield* Azure.Storage.DeleteBlobImmutabilityPolicy(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* deleteBlobImmutabilityPolicy({ blob: "evidence.pdf" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.DeleteBlobImmutabilityPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface DeleteBlobImmutabilityPolicy extends Binding.Service<
  DeleteBlobImmutabilityPolicy,
  "Azure.Storage.DeleteBlobImmutabilityPolicy",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: DeleteBlobImmutabilityPolicyRequest,
    ) => Effect.Effect<
      blob.DeleteBlobImmutabilityPolicyResponse,
      blob.DeleteBlobImmutabilityPolicyError,
      RuntimeContext
    >
  >
> {}

export const DeleteBlobImmutabilityPolicy = Binding.Service<DeleteBlobImmutabilityPolicy>(
  "Azure.Storage.DeleteBlobImmutabilityPolicy",
);
