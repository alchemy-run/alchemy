import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetBlobLegalHold` request without the `url` and `containerName` the bound container supplies. */
export interface SetBlobLegalHoldRequest extends Omit<
  blob.SetBlobLegalHoldRequest,
  "url" | "containerName"
> {}

/**
 * Set or clear a legal hold on a blob (`Set Blob Legal Hold`). The container
 * needs version-level immutability.
 *
 * Binding grants a custom role with only `containers/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetBlobLegalHoldHttp}.
 *
 * ### Legal Holds
 * **Example:** Place a legal hold
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
 *     const setBlobLegalHold = yield* Azure.Storage.SetBlobLegalHold(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setBlobLegalHold({ blob: "evidence.pdf", xMsLegalHold: true });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetBlobLegalHoldHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetBlobLegalHold extends Binding.Service<
  SetBlobLegalHold,
  "Azure.Storage.SetBlobLegalHold",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetBlobLegalHoldRequest,
    ) => Effect.Effect<blob.SetBlobLegalHoldResponse, blob.SetBlobLegalHoldError, RuntimeContext>
  >
> {}

export const SetBlobLegalHold = Binding.Service<SetBlobLegalHold>("Azure.Storage.SetBlobLegalHold");
