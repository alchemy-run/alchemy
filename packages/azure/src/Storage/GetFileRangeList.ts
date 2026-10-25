import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `FileGetRangeList` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type GetFileRangeListRequest = FileShareRequest<files.FileGetRangeListRequest>;

/**
 * List the written byte ranges of a file in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `FileGetRangeList`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link GetFileRangeListHttp}.
 *
 * ### Listing File Ranges
 * **Example:** List a file's written ranges
 * ```typescript
 * // init
 * const getFileRangeList = yield* Azure.Storage.GetFileRangeList(share);
 *
 * // runtime
 * const { Ranges } = yield* getFileRangeList({ fileName: "disks/data.vhd" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetFileRangeList extends Binding.Service<
  GetFileRangeList,
  "Azure.Storage.GetFileRangeList",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: GetFileRangeListRequest,
    ) => Effect.Effect<files.FileGetRangeListResponse, files.FileGetRangeListError, RuntimeContext>
  >
> {}

export const GetFileRangeList = Binding.Service<GetFileRangeList>("Azure.Storage.GetFileRangeList");
