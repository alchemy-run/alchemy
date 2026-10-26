import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `RenewShareLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type RenewShareLeaseRequest = FileShareRequest<files.RenewShareLeaseRequest>;

/**
 * Renew the active lease on an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `RenewShareLease`).
 *
 * Binding assigns the `AzureStorageFileShareLeaser` custom role
 * (`fileServices/shares/lease/action`, created once per stack) on the share
 * only; the built-in roles that hold it also grant share writes and deletes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link RenewShareLeaseHttp}.
 *
 * ### Leasing Shares
 * **Example:** Keep a timed share lease alive
 * ```typescript
 * // init
 * const renewShareLease = yield* Azure.Storage.RenewShareLease(share);
 *
 * // runtime
 * yield* renewShareLease({ xMsLeaseId: leaseId });
 * // …provided with Effect.provide(Azure.Storage.RenewShareLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface RenewShareLease extends Binding.Service<
  RenewShareLease,
  "Azure.Storage.RenewShareLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: RenewShareLeaseRequest,
    ) => Effect.Effect<files.RenewShareLeaseResponse, files.RenewShareLeaseError, RuntimeContext>
  >
> {}

export const RenewShareLease = Binding.Service<RenewShareLease>("Azure.Storage.RenewShareLease");
