import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `ShareReleaseLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ReleaseShareLeaseRequest = FileShareRequest<files.ShareReleaseLeaseRequest>;

/**
 * Release the lease on an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `ShareReleaseLease`).
 *
 * Binding assigns the `AzureStorageFileShareLeaser` custom role
 * (`fileServices/shares/lease/action`, created once per stack) on the share
 * only; the built-in roles that hold it also grant share writes and deletes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link ReleaseShareLeaseHttp}.
 *
 * ### Leasing Shares
 * **Example:** Release a share lease
 * ```typescript
 * // init
 * const releaseShareLease = yield* Azure.Storage.ReleaseShareLease(share);
 *
 * // runtime
 * yield* releaseShareLease({ xMsLeaseId: leaseId });
 * // …provided with Effect.provide(Azure.Storage.ReleaseShareLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ReleaseShareLease extends Binding.Service<
  ReleaseShareLease,
  "Azure.Storage.ReleaseShareLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ReleaseShareLeaseRequest,
    ) => Effect.Effect<files.ShareReleaseLeaseResponse, files.ShareReleaseLeaseError, RuntimeContext>
  >
> {}

export const ReleaseShareLease = Binding.Service<ReleaseShareLease>("Azure.Storage.ReleaseShareLease");
