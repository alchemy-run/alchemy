import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `GetShareAccessPolicy` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type GetShareAccessPolicyRequest = FileShareRequest<files.GetShareAccessPolicyRequest>;

/**
 * Read the stored access policies of an Azure Files share, over the File REST API with Microsoft Entra tokens
 * (`storage-file` `GetShareAccessPolicy`).
 *
 * Binding assigns the `AzureStorageFileSharePropertiesReader` custom role
 * (`fileServices/shares/read`, created once per stack) on the share only;
 * no built-in data role covers share-level reads, and Reader would grant read
 * on every resource in its scope. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity. On any other host
 * (a Cloudflare Worker, an AWS Lambda) Alchemy creates an Entra service
 * principal for the host, assigns the role to it, and binds its client
 * secret into the host's env (see `AzureBindings`).
 * Provide {@link GetShareAccessPolicyHttp}.
 *
 * ### Reading Access Policies
 * **Example:** List a share's stored access policies
 * ```typescript
 * // init
 * const getShareAccessPolicy = yield* Azure.Storage.GetShareAccessPolicy(share);
 *
 * // runtime
 * const identifiers = yield* getShareAccessPolicy();
 * // …provided with Effect.provide(Azure.Storage.GetShareAccessPolicyHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetShareAccessPolicy extends Binding.Service<
  GetShareAccessPolicy,
  "Azure.Storage.GetShareAccessPolicy",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: GetShareAccessPolicyRequest,
    ) => Effect.Effect<files.GetShareAccessPolicyResponse, files.GetShareAccessPolicyError, RuntimeContext>
  >
> {}

export const GetShareAccessPolicy = Binding.Service<GetShareAccessPolicy>("Azure.Storage.GetShareAccessPolicy");
