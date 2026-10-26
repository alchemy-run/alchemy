import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `ListFileHandles` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ListFileHandlesRequest = FileShareRequest<files.ListFileHandlesRequest>;

/**
 * List the open SMB handles on a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `ListFileHandles`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link ListFileHandlesHttp}.
 *
 * ### Listing Handles
 * **Example:** List who has a file open
 * ```typescript
 * // init
 * const listFileHandles = yield* Azure.Storage.ListFileHandles(share);
 *
 * // runtime
 * const { HandleList } = yield* listFileHandles({ fileName: "reports/q1.xlsx" });
 * // …provided with Effect.provide(Azure.Storage.ListFileHandlesHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListFileHandles extends Binding.Service<
  ListFileHandles,
  "Azure.Storage.ListFileHandles",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ListFileHandlesRequest,
    ) => Effect.Effect<files.ListFileHandlesResponse, files.ListFileHandlesError, RuntimeContext>
  >
> {}

export const ListFileHandles = Binding.Service<ListFileHandles>("Azure.Storage.ListFileHandles");
