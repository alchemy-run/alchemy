import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `CreateShareSnapshot` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type CreateShareSnapshotRequest = FileShareRequest<files.CreateShareSnapshotRequest>;

/**
 * Take a read-only snapshot of an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `CreateShareSnapshot`).
 *
 * Binding assigns the `AzureStorageFileSharePropertiesWriter` custom role
 * (`fileServices/shares/write`, created once per stack) on the share only;
 * the built-in roles that hold it (Contributor, Storage Account Contributor)
 * also grant deletes and every other storage resource. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link CreateShareSnapshotHttp}.
 *
 * ### Snapshotting Shares
 * **Example:** Snapshot a share before a migration
 * ```typescript
 * // init
 * const createShareSnapshot = yield* Azure.Storage.CreateShareSnapshot(share);
 *
 * // runtime
 * const { xMsSnapshot } = yield* createShareSnapshot({ metadata: { reason: "pre-migration" } });
 * // …provided with Effect.provide(Azure.Storage.CreateShareSnapshotHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateShareSnapshot extends Binding.Service<
  CreateShareSnapshot,
  "Azure.Storage.CreateShareSnapshot",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: CreateShareSnapshotRequest,
    ) => Effect.Effect<files.CreateShareSnapshotResponse, files.CreateShareSnapshotError, RuntimeContext>
  >
> {}

export const CreateShareSnapshot = Binding.Service<CreateShareSnapshot>("Azure.Storage.CreateShareSnapshot");
