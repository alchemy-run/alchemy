import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlobChangeLease` request without the `url` and `containerName` the bound container supplies. */
export interface ChangeBlobLeaseRequest extends Omit<
  blob.BlobChangeLeaseRequest,
  "url" | "containerName"
> {}

/**
 * Change the ID of an active blob lease (`Lease Blob` with `change`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link ChangeBlobLeaseHttp}.
 *
 * ### Changing Blob Leases
 * **Example:** Hand a lease to a new ID
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
 *     const changeBlobLease = yield* Azure.Storage.ChangeBlobLease(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* changeBlobLease({ blob: "state.json", xMsLeaseId: leaseId, xMsProposedLeaseId: crypto.randomUUID() });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ChangeBlobLeaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ChangeBlobLease extends Binding.Service<
  ChangeBlobLease,
  "Azure.Storage.ChangeBlobLease",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: ChangeBlobLeaseRequest,
    ) => Effect.Effect<blob.BlobChangeLeaseResponse, blob.BlobChangeLeaseError, RuntimeContext>
  >
> {}

export const ChangeBlobLease = Binding.Service<ChangeBlobLease>("Azure.Storage.ChangeBlobLease");
