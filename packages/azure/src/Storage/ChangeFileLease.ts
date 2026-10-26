import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `FileChangeLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ChangeFileLeaseRequest = FileShareRequest<files.FileChangeLeaseRequest>;

/**
 * Change the ID of the active lease on a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `FileChangeLease`).
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
 * Provide {@link ChangeFileLeaseHttp}.
 *
 * ### Leasing Files
 * **Example:** Hand a file lease to a new lease ID
 * ```typescript
 * // init
 * const changeFileLease = yield* Azure.Storage.ChangeFileLease(share);
 *
 * // runtime
 * yield* changeFileLease({
 *   fileName: "db/state.json",
 *   xMsLeaseId: leaseId,
 *   xMsProposedLeaseId: "f7c5e0d8-0b1e-4b0a-9b8e-3d2f1a6c5b4e",
 * });
 * // …provided with Effect.provide(Azure.Storage.ChangeFileLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ChangeFileLease extends Binding.Service<
  ChangeFileLease,
  "Azure.Storage.ChangeFileLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ChangeFileLeaseRequest,
    ) => Effect.Effect<files.FileChangeLeaseResponse, files.FileChangeLeaseError, RuntimeContext>
  >
> {}

export const ChangeFileLease = Binding.Service<ChangeFileLease>("Azure.Storage.ChangeFileLease");
