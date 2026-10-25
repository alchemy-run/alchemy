import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `DirectoryListFilesAndDirectoriesSegment` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type ListFilesAndDirectoriesRequest =
  FileShareRequest<files.DirectoryListFilesAndDirectoriesSegmentRequest>;

/**
 * List one page of the files and subdirectories in a directory of an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `DirectoryListFilesAndDirectoriesSegment`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link ListFilesAndDirectoriesHttp}.
 *
 * ### Listing a Directory
 * **Example:** List the share root
 * ```typescript
 * // init
 * const listFilesAndDirectories = yield* Azure.Storage.ListFilesAndDirectories(share);
 *
 * // runtime
 * const page = yield* listFilesAndDirectories({ directory: "" });
 * const names = page.Segment.FileItems.map((item) => item.Name.content);
 * ```
 *
 * **Example:** List a directory by prefix
 * ```typescript
 * const page = yield* listFilesAndDirectories({ directory: "reports", prefix: "2026-" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListFilesAndDirectories extends Binding.Service<
  ListFilesAndDirectories,
  "Azure.Storage.ListFilesAndDirectories",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: ListFilesAndDirectoriesRequest,
    ) => Effect.Effect<
      files.DirectoryListFilesAndDirectoriesSegmentResponse,
      files.DirectoryListFilesAndDirectoriesSegmentError,
      RuntimeContext
    >
  >
> {}

export const ListFilesAndDirectories = Binding.Service<ListFilesAndDirectories>(
  "Azure.Storage.ListFilesAndDirectories",
);
