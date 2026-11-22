import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `FileAcquireLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type AcquireFileLeaseRequest = FileShareRequest<files.FileAcquireLeaseRequest>;

/**
 * Acquire an infinite write lease on a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `FileAcquireLease`).
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
 * Provide {@link AcquireFileLeaseHttp}.
 *
 * ### Leasing Files
 * **Example:** Lock a file for exclusive writes
 * ```typescript
 * // init
 * const acquireFileLease = yield* Azure.Storage.AcquireFileLease(share);
 *
 * // runtime
 * const { xMsLeaseId } = yield* acquireFileLease({ fileName: "db/state.json", xMsLeaseDuration: -1 });
 * // …provided with Effect.provide(Azure.Storage.AcquireFileLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface AcquireFileLease extends Binding.Service<
  AcquireFileLease,
  "Azure.Storage.AcquireFileLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: AcquireFileLeaseRequest,
    ) => Effect.Effect<files.FileAcquireLeaseResponse, files.FileAcquireLeaseError, RuntimeContext>
  >
> {}

export const AcquireFileLease = Binding.Service<AcquireFileLease>("Azure.Storage.AcquireFileLease");
