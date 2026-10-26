import type * as files from "@distilled.cloud/azure/storage-file";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { FileShare } from "./FileShare.ts";
import type { FileShareRequest } from "./FileShareTypes.ts";

/** `SetShareAccessPolicy` without the `url`, `shareName` and `xMsFileRequestIntent` the bound share supplies. */
export type SetShareAccessPolicyRequest = FileShareRequest<files.SetShareAccessPolicyRequest>;

/**
 * Replace the stored access policies of an Azure Files share (the policies SAS tokens can reference), over the File REST API with Microsoft Entra tokens
 * (`storage-file` `SetShareAccessPolicy`).
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
 * Provide {@link SetShareAccessPolicyHttp}.
 *
 * ### Setting Access Policies
 * **Example:** Add a read-only stored access policy
 * ```typescript
 * // init
 * const setShareAccessPolicy = yield* Azure.Storage.SetShareAccessPolicy(share);
 *
 * // runtime
 * yield* setShareAccessPolicy({
 *   body: [{ Id: "readers", AccessPolicy: { Permission: "rl", Expiry: "2027-01-01T00:00:00Z" } }],
 * });
 * // …provided with Effect.provide(Azure.Storage.SetShareAccessPolicyHttp)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetShareAccessPolicy extends Binding.Service<
  SetShareAccessPolicy,
  "Azure.Storage.SetShareAccessPolicy",
  (
    share: FileShare,
  ) => Effect.Effect<
    (
      request?: SetShareAccessPolicyRequest,
    ) => Effect.Effect<files.SetShareAccessPolicyResponse, files.SetShareAccessPolicyError, RuntimeContext>
  >
> {}

export const SetShareAccessPolicy = Binding.Service<SetShareAccessPolicy>("Azure.Storage.SetShareAccessPolicy");
