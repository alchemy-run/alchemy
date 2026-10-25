import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `GetDirectoryProperties` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type GetDirectoryPropertiesRequest = FileShareRequest<files.GetDirectoryPropertiesRequest>;

/**
 * Read a directory's properties and metadata in an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `GetDirectoryProperties`).
 *
 * Binding assigns **Storage File Data Privileged Reader** (`fileshares/files/read` +
 * `readFileBackupSemantics/action`) on the share only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link GetDirectoryPropertiesHttp}.
 *
 * ### Reading Directory Properties
 * **Example:** Check that a directory exists
 * ```typescript
 * // init
 * const getDirectoryProperties = yield* Azure.Storage.GetDirectoryProperties(share);
 *
 * // runtime
 * const props = yield* getDirectoryProperties({ directory: "reports" });
 * const etag = props.eTag;
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetDirectoryProperties extends Binding.Service<
  GetDirectoryProperties,
  "Azure.Storage.GetDirectoryProperties",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request: GetDirectoryPropertiesRequest,
    ) => Effect.Effect<
      files.GetDirectoryPropertiesResponse,
      files.GetDirectoryPropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetDirectoryProperties = Binding.Service<GetDirectoryProperties>(
  "Azure.Storage.GetDirectoryProperties",
);
