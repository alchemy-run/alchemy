import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `GetFileProperties` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type GetFilePropertiesRequest = FileShareRequest<files.GetFilePropertiesRequest>;

/**
 * Read a file's properties and metadata in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `GetFileProperties`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link GetFilePropertiesHttp}.
 *
 * ### Reading File Properties
 * **Example:** Read a file's size
 * ```typescript
 * // init
 * const getFileProperties = yield* Azure.Storage.GetFileProperties(share);
 *
 * // runtime
 * const props = yield* getFileProperties({ fileName: "reports/q1.csv" });
 * const size = props.contentLength;
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetFileProperties extends Binding.Service<
  GetFileProperties,
  "Azure.Storage.GetFileProperties",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: GetFilePropertiesRequest,
    ) => Effect.Effect<
      files.GetFilePropertiesResponse,
      files.GetFilePropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetFileProperties = Binding.Service<GetFileProperties>(
  "Azure.Storage.GetFileProperties",
);
