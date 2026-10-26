import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `ShareAcquireLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type AcquireShareLeaseRequest = FileShareRequest<files.ShareAcquireLeaseRequest>;

/**
 * Acquire a lease on an Azure Files share, which blocks deleting the share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `ShareAcquireLease`).
 *
 * Binding assigns the `AzureStorageFileShareLeaser` custom role
 * (`fileServices/shares/lease/action`, created once per stack) on the share
 * only; the built-in roles that hold it also grant share writes and deletes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link AcquireShareLeaseHttp}.
 *
 * ### Leasing Shares
 * **Example:** Lock a share against deletion
 * ```typescript
 * // init
 * const acquireShareLease = yield* Azure.Storage.AcquireShareLease(share);
 *
 * // runtime
 * const { xMsLeaseId } = yield* acquireShareLease({ xMsLeaseDuration: -1 });
 * // …provided with Effect.provide(Azure.Storage.AcquireShareLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface AcquireShareLease extends Binding.Service<
  AcquireShareLease,
  "Azure.Storage.AcquireShareLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: AcquireShareLeaseRequest,
    ) => Effect.Effect<files.ShareAcquireLeaseResponse, files.ShareAcquireLeaseError, RuntimeContext>
  >
> {}

export const AcquireShareLease = Binding.Service<AcquireShareLease>("Azure.Storage.AcquireShareLease");
