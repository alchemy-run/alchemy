import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `FileReleaseLease` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ReleaseFileLeaseRequest = FileShareRequest<files.FileReleaseLeaseRequest>;

/**
 * Release the lease on a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `FileReleaseLease`).
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
 * Provide {@link ReleaseFileLeaseHttp}.
 *
 * ### Leasing Files
 * **Example:** Release a file lease
 * ```typescript
 * // init
 * const releaseFileLease = yield* Azure.Storage.ReleaseFileLease(share);
 *
 * // runtime
 * yield* releaseFileLease({ fileName: "db/state.json", xMsLeaseId: leaseId });
 * // …provided with Effect.provide(Azure.Storage.ReleaseFileLeaseHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ReleaseFileLease extends Binding.Service<
  ReleaseFileLease,
  "Azure.Storage.ReleaseFileLease",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ReleaseFileLeaseRequest,
    ) => Effect.Effect<files.FileReleaseLeaseResponse, files.FileReleaseLeaseError, RuntimeContext>
  >
> {}

export const ReleaseFileLease = Binding.Service<ReleaseFileLease>("Azure.Storage.ReleaseFileLease");
