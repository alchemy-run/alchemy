import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `ContainerBreakLease` request without the `url` and `containerName` the bound container supplies. */
export interface BreakContainerLeaseRequest extends Omit<
  blob.ContainerBreakLeaseRequest,
  "url" | "containerName"
> {}

/**
 * Break a container lease, now or after a break period (`Lease Container`
 * with `break`).
 *
 * Binding grants a custom role with only `containers/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link BreakContainerLeaseHttp}.
 *
 * ### Breaking Container Leases
 * **Example:** Break a container lease now
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
 *     const breakContainerLease = yield* Azure.Storage.BreakContainerLease(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* breakContainerLease({ xMsLeaseBreakPeriod: 0 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.BreakContainerLeaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BreakContainerLease extends Binding.Service<
  BreakContainerLease,
  "Azure.Storage.BreakContainerLease",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request?: BreakContainerLeaseRequest,
    ) => Effect.Effect<
      blob.ContainerBreakLeaseResponse,
      blob.ContainerBreakLeaseError,
      RuntimeContext
    >
  >
> {}

export const BreakContainerLease = Binding.Service<BreakContainerLease>(
  "Azure.Storage.BreakContainerLease",
);
