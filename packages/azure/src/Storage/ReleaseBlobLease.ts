import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlobReleaseLease` request without the `url` and `containerName` the bound container supplies. */
export interface ReleaseBlobLeaseRequest extends Omit<
  blob.BlobReleaseLeaseRequest,
  "url" | "containerName"
> {}

/**
 * Release a blob lease so another client can acquire it (`Lease Blob` with
 * `release`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link ReleaseBlobLeaseHttp}.
 *
 * ### Releasing Blob Leases
 * **Example:** Release a lease
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
 *     const releaseBlobLease = yield* Azure.Storage.ReleaseBlobLease(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* releaseBlobLease({ blob: "state.json", xMsLeaseId: leaseId });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ReleaseBlobLeaseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ReleaseBlobLease extends Binding.Service<
  ReleaseBlobLease,
  "Azure.Storage.ReleaseBlobLease",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: ReleaseBlobLeaseRequest,
    ) => Effect.Effect<blob.BlobReleaseLeaseResponse, blob.BlobReleaseLeaseError, RuntimeContext>
  >
> {}

export const ReleaseBlobLease = Binding.Service<ReleaseBlobLease>("Azure.Storage.ReleaseBlobLease");
