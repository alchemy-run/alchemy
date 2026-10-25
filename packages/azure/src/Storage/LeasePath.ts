import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface LeasePathRequest extends Omit<datalake.PathLeaseRequest, "url" | "filesystem"> {}

/**
 * Acquire, renew, change, break, or release a lease on a Data Lake file
 * (`Path_Lease`). Works from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on
 * the filesystem only. Storage Blob Data Contributor would also grant read
 * and delete, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakePathWriteRole`, defined once per stack at the subscription and
 * shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link LeasePathHttp}.
 *
 * ### Leasing Files
 * **Example:** Hold a file for 15 seconds
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const leasePath = yield* Azure.Storage.LeasePath(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { xMsLeaseId } = yield* leasePath({
 *           path: "raw/events.log",
 *           xMsLeaseAction: "acquire",
 *           xMsLeaseDuration: 15,
 *           xMsProposedLeaseId: crypto.randomUUID(),
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.LeasePathHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface LeasePath extends Binding.Service<
  LeasePath,
  "Azure.Storage.LeasePath",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: LeasePathRequest,
    ) => Effect.Effect<datalake.PathLeaseResponse, datalake.PathLeaseError, RuntimeContext>
  >
> {}

export const LeasePath = Binding.Service<LeasePath>("Azure.Storage.LeasePath");
