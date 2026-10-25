import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface SetPathAccessControlRecursiveRequest extends Omit<
  datalake.SetPathAccessControlRecursiveRequest,
  "url" | "filesystem"
> {}

/**
 * Set, modify, or remove ACL entries on a Data Lake directory and everything
 * under it (`Path_SetAccessControlRecursive`). Works from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/modifyPermissions/action`
 * on the filesystem only. only Storage Blob Data Owner has it, with full
 * data access, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakePathAclRole`, defined once per stack at the subscription and
 * shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SetPathAccessControlRecursiveHttp}.
 *
 * ### Setting ACLs Recursively
 * **Example:** Give a principal read access to a tree
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const setAclRecursive = yield* Azure.Storage.SetPathAccessControlRecursive(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* setAclRecursive({
 *           path: "raw",
 *           mode: "modify",
 *           xMsAcl: `user:${principalId}:r-x`,
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetPathAccessControlRecursiveHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetPathAccessControlRecursive extends Binding.Service<
  SetPathAccessControlRecursive,
  "Azure.Storage.SetPathAccessControlRecursive",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetPathAccessControlRecursiveRequest,
    ) => Effect.Effect<
      datalake.SetPathAccessControlRecursiveResponse,
      datalake.SetPathAccessControlRecursiveError,
      RuntimeContext
    >
  >
> {}

export const SetPathAccessControlRecursive = Binding.Service<SetPathAccessControlRecursive>(
  "Azure.Storage.SetPathAccessControlRecursive",
);
