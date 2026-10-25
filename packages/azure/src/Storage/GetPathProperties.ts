import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface GetPathPropertiesRequest extends Omit<
  datalake.GetPathPropertiesRequest,
  "url" | "filesystem"
> {}

/**
 * Read a Data Lake path's properties, status, or access control list
 * (`Path_GetProperties`). Works from any host.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns **Storage Blob Data Reader** on the filesystem only. Its
 * only data action is
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link GetPathPropertiesHttp}.
 *
 * ### Reading Properties
 * **Example:** Read a path's ACL
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const getPathProperties = yield* Azure.Storage.GetPathProperties(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { xMsAcl, xMsOwner } = yield* getPathProperties({
 *           path: "raw",
 *           action: "getAccessControl",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetPathPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetPathProperties extends Binding.Service<
  GetPathProperties,
  "Azure.Storage.GetPathProperties",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: GetPathPropertiesRequest,
    ) => Effect.Effect<
      datalake.GetPathPropertiesResponse,
      datalake.GetPathPropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetPathProperties = Binding.Service<GetPathProperties>(
  "Azure.Storage.GetPathProperties",
);
