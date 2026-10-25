import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface SetPathAccessControlRequest extends Omit<
  datalake.SetPathAccessControlRequest,
  "url" | "filesystem"
> {}

/**
 * Set the owner, group, permissions, or ACL of a Data Lake path
 * (`Path_SetAccessControl`). Works from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/modifyPermissions/action`
 * and
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/manageOwnership/action`
 * on the filesystem only. only Storage Blob Data Owner has these, with full
 * data access, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakePathAccessControlRole`, defined once per stack at the
 * subscription and shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SetPathAccessControlHttp}.
 *
 * ### Setting Access Control
 * **Example:** Restrict a directory to its owner and group
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const setPathAccessControl = yield* Azure.Storage.SetPathAccessControl(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* setPathAccessControl({ path: "raw", xMsAcl: "user::rwx,group::r-x,other::---" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetPathAccessControlHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetPathAccessControl extends Binding.Service<
  SetPathAccessControl,
  "Azure.Storage.SetPathAccessControl",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetPathAccessControlRequest,
    ) => Effect.Effect<
      datalake.SetPathAccessControlResponse,
      datalake.SetPathAccessControlError,
      RuntimeContext
    >
  >
> {}

export const SetPathAccessControl = Binding.Service<SetPathAccessControl>(
  "Azure.Storage.SetPathAccessControl",
);
