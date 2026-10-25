import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The `Path_Update` members that apply to `action=setProperties`. */
export interface SetPathPropertiesRequest extends Pick<
  datalake.UpdatePathRequest,
  | "path"
  | "timeout"
  | "xMsClientRequestId"
  | "xMsLeaseId"
  | "xMsCacheControl"
  | "xMsContentType"
  | "xMsContentDisposition"
  | "xMsContentEncoding"
  | "xMsContentLanguage"
  | "xMsProperties"
  | "ifMatch"
  | "ifNoneMatch"
  | "ifModifiedSince"
  | "ifUnmodifiedSince"
> {}

/**
 * Set the HTTP headers (`Content-Type`, `Cache-Control`, …) or user
 * properties of a Data Lake file or directory (`Path_Update` with
 * `action=setProperties`). Works from any host. Headers left out are
 * cleared; `xMsProperties` replaces every user property.
 *
 * Bind it to a {@link BlobContainer} used as a Data Lake filesystem (its
 * storage account has `isHnsEnabled: true`); the callable fills in the
 * account's `dfs` endpoint and the filesystem name.
 *
 * Binding assigns a custom role with exactly
 * `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write` on
 * the filesystem only. Storage Blob Data Contributor would also grant read
 * and delete, so the role is the `Azure.Authorization.RoleDefinition`
 * `DataLakePathWriteRole`, defined once per stack at the subscription and
 * shared by every host that binds it.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link SetPathPropertiesHttp}.
 *
 * ### Setting Properties
 * **Example:** Serve a file as JSON
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const setPathProperties = yield* Azure.Storage.SetPathProperties(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* setPathProperties({
 *           path: "reports/latest.json",
 *           xMsContentType: "application/json",
 *           xMsCacheControl: "max-age=60",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetPathPropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetPathProperties extends Binding.Service<
  SetPathProperties,
  "Azure.Storage.SetPathProperties",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetPathPropertiesRequest,
    ) => Effect.Effect<datalake.UpdatePathResponse, datalake.UpdatePathError, RuntimeContext>
  >
> {}

export const SetPathProperties = Binding.Service<SetPathProperties>(
  "Azure.Storage.SetPathProperties",
);
