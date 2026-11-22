import type * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** The distilled request without the filesystem the binding fills in. */
export interface ReadPathRequest extends Omit<datalake.ReadPathRequest, "url" | "filesystem"> {}

/**
 * Read a Data Lake file, or a byte range of it (`Path_Read`). Works from any
 * host.
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
 * Provide {@link ReadPathHttp}.
 *
 * ### Reading Files
 * **Example:** Read a file as text
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Lake: an Azure.Storage.BlobContainer on an account with isHnsEnabled: true
 *     const lake = yield* Lake;
 *     const readPath = yield* Azure.Storage.ReadPath(lake);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const file = yield* readPath({ path: "raw/events.log" });
 *         const text = new TextDecoder().decode(file.body);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ReadPathHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ReadPath extends Binding.Service<
  ReadPath,
  "Azure.Storage.ReadPath",
  (
    fileSystem: BlobContainer,
  ) => Effect.Effect<
    (
      request: ReadPathRequest,
    ) => Effect.Effect<datalake.ReadPathResponse, datalake.ReadPathError, RuntimeContext>
  >
> {}

export const ReadPath = Binding.Service<ReadPath>("Azure.Storage.ReadPath");
