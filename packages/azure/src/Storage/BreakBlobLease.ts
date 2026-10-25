import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlobBreakLease` request without the `url` and `containerName` the bound container supplies. */
export interface BreakBlobLeaseRequest extends Omit<
  blob.BlobBreakLeaseRequest,
  "url" | "containerName"
> {}

/**
 * Break a blob lease, ending it now or after a break period (`Lease Blob`
 * with `break`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link BreakBlobLeaseHttp}.
 *
 * ### Breaking Blob Leases
 * **Example:** Break a lease now
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
 *     const breakBlobLease = yield* Azure.Storage.BreakBlobLease(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* breakBlobLease({ blob: "state.json", xMsLeaseBreakPeriod: 0 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.BreakBlobLeaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BreakBlobLease extends Binding.Service<
  BreakBlobLease,
  "Azure.Storage.BreakBlobLease",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: BreakBlobLeaseRequest,
    ) => Effect.Effect<blob.BlobBreakLeaseResponse, blob.BlobBreakLeaseError, RuntimeContext>
  >
> {}

export const BreakBlobLease = Binding.Service<BreakBlobLease>("Azure.Storage.BreakBlobLease");
