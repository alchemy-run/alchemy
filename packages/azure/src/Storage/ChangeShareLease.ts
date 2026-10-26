import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `ShareChangeLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ChangeShareLeaseRequest = FileShareRequest<files.ShareChangeLeaseRequest>;

/**
 * Change the ID of the active lease on an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `ShareChangeLease`).
 *
 * Binding assigns the `AzureStorageFileShareLeaser` custom role
 * (`fileServices/shares/lease/action`, created once per stack) on the share
 * only; the built-in roles that hold it also grant share writes and deletes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link ChangeShareLeaseHttp}.
 *
 * ### Leasing Shares
 * **Example:** Hand a share lease to a new lease ID
 * ```typescript
 * // init
 * const changeShareLease = yield* Azure.Storage.ChangeShareLease(share);
 *
 * // runtime
 * yield* changeShareLease({ xMsLeaseId: leaseId, xMsProposedLeaseId: "0c7f6c1e-5d1a-4d36-8a3c-2b9f7e4d1a20" });
 * // …provided with Effect.provide(Azure.Storage.ChangeShareLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ChangeShareLease extends Binding.Service<
  ChangeShareLease,
  "Azure.Storage.ChangeShareLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ChangeShareLeaseRequest,
    ) => Effect.Effect<files.ShareChangeLeaseResponse, files.ShareChangeLeaseError, RuntimeContext>
  >
> {}

export const ChangeShareLease = Binding.Service<ChangeShareLease>("Azure.Storage.ChangeShareLease");
