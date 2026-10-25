import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `RenewBlobLease` request without the `url` and `containerName` the bound container supplies. */
export interface RenewBlobLeaseRequest extends Omit<
  blob.RenewBlobLeaseRequest,
  "url" | "containerName"
> {}

/**
 * Renew a blob lease for another lease duration (`Lease Blob` with `renew`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link RenewBlobLeaseHttp}.
 *
 * ### Renewing Blob Leases
 * **Example:** Renew a lease
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
 *     const renewBlobLease = yield* Azure.Storage.RenewBlobLease(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* renewBlobLease({ blob: "state.json", xMsLeaseId: leaseId });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.RenewBlobLeaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface RenewBlobLease extends Binding.Service<
  RenewBlobLease,
  "Azure.Storage.RenewBlobLease",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: RenewBlobLeaseRequest,
    ) => Effect.Effect<blob.RenewBlobLeaseResponse, blob.RenewBlobLeaseError, RuntimeContext>
  >
> {}

export const RenewBlobLease = Binding.Service<RenewBlobLease>("Azure.Storage.RenewBlobLease");
