import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type {
  FileShareError,
  ListShareFilesOptions,
  ListShareFilesResult,
  ShareFile,
  ShareFileProperties,
} from "./FileShareTypes.ts";

/** Read-only client for one file share. Paths are relative to the share root. */
export interface ReadFileShareClient {
  /** Download a file; `undefined` when it (or its directory) does not exist. */
  get(path: string): Effect.Effect<ShareFile | undefined, FileShareError, RuntimeContext>;
  /** Read a file's properties; `undefined` when it does not exist. */
  head(
    path: string,
  ): Effect.Effect<ShareFileProperties | undefined, FileShareError, RuntimeContext>;
  /** List one page of the files and subdirectories directly in a directory. */
  list(
    options?: ListShareFilesOptions,
  ): Effect.Effect<ListShareFilesResult, FileShareError, RuntimeContext>;
}

/**
 * Read access to an Azure Files share from any host, over the File REST API
 * with Microsoft Entra tokens.
 *
 * Binding assigns **Storage File Data Privileged Reader** (data actions
 * `fileshares/files/read` and `readFileBackupSemantics/action`) on the share
 * only. Entra-token access to Azure Files always uses backup semantics, so
 * it reads every file regardless of NTFS ACLs. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity. On any other host (a Cloudflare Worker, an AWS Lambda) Alchemy
 * creates an Entra service principal for the host, assigns the role to it,
 * and binds its client secret into the host's env (see `AzureBindings`).
 * Provide {@link FileShareReadHttp}.
 *
 * ### Reading Files
 * **Example:** Read a file as text
 * ```typescript
 * // init
 * const docs = yield* Azure.Storage.FileShareRead(share);
 *
 * // runtime
 * const file = yield* docs.get("reports/latest.json");
 * const report = file ? JSON.parse(file.text()) : undefined;
 * // …provided with Effect.provide(Azure.Storage.FileShareReadHttp)
 * ```
 *
 * **Example:** List a directory
 * ```typescript
 * const { files, directories } = yield* docs.list({ directory: "reports" });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface FileShareRead extends Binding.Service<
  FileShareRead,
  "Azure.Storage.FileShareRead",
  (share: FileShare) => Effect.Effect<ReadFileShareClient>
> {}

export const FileShareRead = Binding.Service<FileShareRead>("Azure.Storage.FileShareRead");
