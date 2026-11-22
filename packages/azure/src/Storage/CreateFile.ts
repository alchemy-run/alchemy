import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `CreateFile` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type CreateFileRequest = FileShareRequest<files.CreateFileRequest>;

/**
 * Create (or replace) a file of a given size in an Azure Files share; write its content with `UploadFileRange`, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `CreateFile`).
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
 * Provide {@link CreateFileHttp}.
 *
 * ### Creating Files
 * **Example:** Create an empty 1 KiB file
 * ```typescript
 * // init
 * const createFile = yield* Azure.Storage.CreateFile(share);
 *
 * // runtime
 * yield* createFile({ fileName: "logs/today.log", xMsContentLength: 1024 });
 * // …provided with Effect.provide(Azure.Storage.CreateFileHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateFile extends Binding.Service<
  CreateFile,
  "Azure.Storage.CreateFile",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: CreateFileRequest,
    ) => Effect.Effect<files.CreateFileResponse, files.CreateFileError, RuntimeContext>
  >
> {}

export const CreateFile = Binding.Service<CreateFile>("Azure.Storage.CreateFile");
