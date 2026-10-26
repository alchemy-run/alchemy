import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `ListDirectoryHandles` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ListDirectoryHandlesRequest = FileShareRequest<files.ListDirectoryHandlesRequest>;

/**
 * List the open SMB handles on a directory (and, recursively, its files) in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `ListDirectoryHandles`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link ListDirectoryHandlesHttp}.
 *
 * ### Listing Handles
 * **Example:** List every open handle under a directory
 * ```typescript
 * // init
 * const listDirectoryHandles = yield* Azure.Storage.ListDirectoryHandles(share);
 *
 * // runtime
 * const { HandleList } = yield* listDirectoryHandles({ directory: "reports", xMsRecursive: true });
 * // …provided with Effect.provide(Azure.Storage.ListDirectoryHandlesHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListDirectoryHandles extends Binding.Service<
  ListDirectoryHandles,
  "Azure.Storage.ListDirectoryHandles",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ListDirectoryHandlesRequest,
    ) => Effect.Effect<files.ListDirectoryHandlesResponse, files.ListDirectoryHandlesError, RuntimeContext>
  >
> {}

export const ListDirectoryHandles = Binding.Service<ListDirectoryHandles>("Azure.Storage.ListDirectoryHandles");
