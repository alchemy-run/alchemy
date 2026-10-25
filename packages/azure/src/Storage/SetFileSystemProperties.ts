import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface SetFileSystemPropertiesRequest extends Omit<
  datalake.SetFileSystemPropertiesRequest,
  "url" | "filesystem"
> {}

/**
 * Set the user properties of a Data Lake filesystem
 * (`FileSystem_SetProperties`). Works from any host. `xMsProperties`
 * (`"name=<base64 value>,…"`) replaces every user property; the binding
 * reads the current properties first and keeps Alchemy's ownership markers
 * (`alchemy_*`), so the {@link BlobContainer} stays owned by its stack.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/read` and
 * `Microsoft.Storage/storageAccounts/blobServices/containers/write` on the
 * filesystem only. Storage Blob Data Contributor would also grant data
 * access to every file, so the role is the
 * `Azure.Authorization.RoleDefinition` `DataLakeFileSystemWriteRole`,
 * defined once per stack at the subscription and shared by every host that
 * binds it. The same two actions also allow management-plane reads and
 * writes of the container, which is how Azure authorizes this operation.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SetFileSystemPropertiesHttp}.
 *
 * ### Setting Filesystem Properties
 * **Example:** Record the last import
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const setFileSystemProperties = yield* Azure.Storage.SetFileSystemProperties(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* setFileSystemProperties({ xMsProperties: `lastImport=${btoa("2026-10-24")}` });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetFileSystemPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetFileSystemProperties extends Binding.Service<
  SetFileSystemProperties,
  "Azure.Storage.SetFileSystemProperties",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request?: SetFileSystemPropertiesRequest,
    ) => Effect.Effect<
      datalake.SetFileSystemPropertiesResponse,
      datalake.SetFileSystemPropertiesError | datalake.GetFileSystemPropertiesError,
      RuntimeContext
    >
  >
> {}

export const SetFileSystemProperties = Binding.Service<SetFileSystemProperties>(
  "Azure.Storage.SetFileSystemProperties",
);
