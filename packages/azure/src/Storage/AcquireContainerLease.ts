import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `ContainerAcquireLease` request without the `url` and `containerName` the bound container supplies. */
export interface AcquireContainerLeaseRequest extends Omit<
  blob.ContainerAcquireLeaseRequest,
  "url" | "containerName"
> {}

/**
 * Acquire a lease (a delete lock) on the container (`Lease Container` with
 * `acquire`).
 *
 * Binding grants a custom role with only `containers/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link AcquireContainerLeaseHttp}.
 *
 * ### Leasing Containers
 * **Example:** Lock the container for 60 seconds
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
 *     const acquireContainerLease = yield* Azure.Storage.AcquireContainerLease(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const lease = yield* acquireContainerLease({ xMsLeaseDuration: 60 });
 *         const leaseId = lease.xMsLeaseId;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.AcquireContainerLeaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface AcquireContainerLease extends Binding.Service<
  AcquireContainerLease,
  "Azure.Storage.AcquireContainerLease",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request?: AcquireContainerLeaseRequest,
    ) => Effect.Effect<
      blob.ContainerAcquireLeaseResponse,
      blob.ContainerAcquireLeaseError,
      RuntimeContext
    >
  >
> {}

export const AcquireContainerLease = Binding.Service<AcquireContainerLease>(
  "Azure.Storage.AcquireContainerLease",
);
