import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `FileBreakLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type BreakFileLeaseRequest = FileShareRequest<files.FileBreakLeaseRequest>;

/**
 * Break the active lease on a file in an Azure Files share, without knowing its lease ID, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `FileBreakLease`).
 *
 * Binding assigns the `AzureStorageFileShareWriter` custom role
 * (`fileshares/files/write` + `writeFileBackupSemantics/action`, created
 * once per stack) on the share only; the built-in Privileged Contributor
 * would also grant read, delete and ACL changes. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link BreakFileLeaseHttp}.
 *
 * ### Leasing Files
 * **Example:** Break a stuck file lease
 * ```typescript
 * // init
 * const breakFileLease = yield* Azure.Storage.BreakFileLease(share);
 *
 * // runtime
 * yield* breakFileLease({ fileName: "db/state.json" });
 * // …provided with Effect.provide(Azure.Storage.BreakFileLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BreakFileLease extends Binding.Service<
  BreakFileLease,
  "Azure.Storage.BreakFileLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: BreakFileLeaseRequest,
    ) => Effect.Effect<files.FileBreakLeaseResponse, files.FileBreakLeaseError, RuntimeContext>
  >
> {}

export const BreakFileLease = Binding.Service<BreakFileLease>("Azure.Storage.BreakFileLease");
