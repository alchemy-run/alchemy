import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `ShareBreakLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type BreakShareLeaseRequest = FileShareRequest<files.ShareBreakLeaseRequest>;

/**
 * Break the active lease on an Azure Files share, without knowing its lease ID, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `ShareBreakLease`).
 *
 * Binding assigns the `AzureStorageFileShareLeaser` custom role
 * (`fileServices/shares/lease/action`, created once per stack) on the share
 * only; the built-in roles that hold it also grant share writes and deletes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link BreakShareLeaseHttp}.
 *
 * ### Leasing Shares
 * **Example:** Break a share lease immediately
 * ```typescript
 * // init
 * const breakShareLease = yield* Azure.Storage.BreakShareLease(share);
 *
 * // runtime
 * yield* breakShareLease({ xMsLeaseBreakPeriod: 0 });
 * // …provided with Effect.provide(Azure.Storage.BreakShareLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BreakShareLease extends Binding.Service<
  BreakShareLease,
  "Azure.Storage.BreakShareLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: BreakShareLeaseRequest,
    ) => Effect.Effect<files.ShareBreakLeaseResponse, files.ShareBreakLeaseError, RuntimeContext>
  >
> {}

export const BreakShareLease = Binding.Service<BreakShareLease>("Azure.Storage.BreakShareLease");
