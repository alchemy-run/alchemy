import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `ContainerChangeLease` request without the `url` and `containerName` the bound container supplies. */
export interface ChangeContainerLeaseRequest extends Omit<
  blob.ContainerChangeLeaseRequest,
  "url" | "containerName"
> {}

/**
 * Change the ID of an active container lease (`Lease Container` with
 * `change`).
 *
 * Binding grants a custom role with only `containers/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link ChangeContainerLeaseHttp}.
 *
 * ### Changing Container Leases
 * **Example:** Hand a container lease to a new ID
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
 *     const changeContainerLease = yield* Azure.Storage.ChangeContainerLease(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* changeContainerLease({ xMsLeaseId: leaseId, xMsProposedLeaseId: crypto.randomUUID() });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ChangeContainerLeaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ChangeContainerLease extends Binding.Service<
  ChangeContainerLease,
  "Azure.Storage.ChangeContainerLease",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: ChangeContainerLeaseRequest,
    ) => Effect.Effect<
      blob.ContainerChangeLeaseResponse,
      blob.ContainerChangeLeaseError,
      RuntimeContext
    >
  >
> {}

export const ChangeContainerLease = Binding.Service<ChangeContainerLease>(
  "Azure.Storage.ChangeContainerLease",
);
