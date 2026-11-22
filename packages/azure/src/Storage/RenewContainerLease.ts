import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `RenewContainerLease` request without the `url` and `containerName` the bound container supplies. */
export interface RenewContainerLeaseRequest extends Omit<
  blob.RenewContainerLeaseRequest,
  "url" | "containerName"
> {}

/**
 * Renew a container lease (`Lease Container` with `renew`).
 *
 * Binding grants a custom role with only `containers/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link RenewContainerLeaseHttp}.
 *
 * ### Renewing Container Leases
 * **Example:** Renew a container lease
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
 *     const renewContainerLease = yield* Azure.Storage.RenewContainerLease(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* renewContainerLease({ xMsLeaseId: leaseId });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.RenewContainerLeaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface RenewContainerLease extends Binding.Service<
  RenewContainerLease,
  "Azure.Storage.RenewContainerLease",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: RenewContainerLeaseRequest,
    ) => Effect.Effect<
      blob.RenewContainerLeaseResponse,
      blob.RenewContainerLeaseError,
      RuntimeContext
    >
  >
> {}

export const RenewContainerLease = Binding.Service<RenewContainerLease>(
  "Azure.Storage.RenewContainerLease",
);
