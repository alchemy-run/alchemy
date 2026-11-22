import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `BlobStartCopyFromURL` request without the `url` and `containerName` the bound container supplies. */
export interface StartCopyBlobRequest extends Omit<
  blob.BlobStartCopyFromURLRequest,
  "url" | "containerName"
> {}

/**
 * Start an asynchronous copy of a blob or a URL into a blob (`Copy Blob`).
 *
 * Binding grants a custom role with only `blobs/read` and `blobs/write` (the
 * source must be in the same container, or be public or carry a SAS),
 * assigned on the bound container only. On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container group,
 * VM, or AKS workload identity) the role goes to that identity; any other
 * host gets an Entra service principal with the role and its client secret
 * in the host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link StartCopyBlobHttp}.
 *
 * ### Copying Blobs
 * **Example:** Copy a blob in the same container
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *     const files = yield* Azure.Storage.BlobContainer("Files", {
 *       storageAccount: account.storageAccountName,
 *     });
 *
 *     // init: bind the operation to the container
 *     const startCopyBlob = yield* Azure.Storage.StartCopyBlob(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const res = yield* startCopyBlob({
 *           blob: "copy.txt",
 *           xMsCopySource: "https://myaccount.blob.core.windows.net/files/hello.txt",
 *         });
 *         const copyId = res.xMsCopyId;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.StartCopyBlobHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface StartCopyBlob extends Binding.Service<
  StartCopyBlob,
  "Azure.Storage.StartCopyBlob",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: StartCopyBlobRequest,
    ) => Effect.Effect<
      blob.BlobStartCopyFromURLResponse,
      blob.BlobStartCopyFromURLError,
      RuntimeContext
    >
  >
> {}

export const StartCopyBlob = Binding.Service<StartCopyBlob>("Azure.Storage.StartCopyBlob");
