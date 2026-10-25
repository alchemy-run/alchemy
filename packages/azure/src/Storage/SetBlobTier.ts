import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetBlobTier` request without the `url` and `containerName` the bound container supplies. */
export interface SetBlobTierRequest extends Omit<
  blob.SetBlobTierRequest,
  "url" | "containerName"
> {}

/**
 * Move a block blob to the Hot, Cool, Cold, or Archive access tier (`Set
 * Blob Tier`).
 *
 * Binding grants a custom role with only `blobs/write`, assigned on the
 * bound container only. On a host with a managed identity (an Azure
 * Function, Function App, Web App, Container App, container group, VM, or
 * AKS workload identity) the role goes to that identity; any other host gets
 * an Entra service principal with the role and its client secret in the
 * host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetBlobTierHttp}.
 *
 * ### Changing Access Tiers
 * **Example:** Move a blob to Cool
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
 *     const setBlobTier = yield* Azure.Storage.SetBlobTier(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setBlobTier({ blob: "reports/2024.json", xMsAccessTier: "Cool" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetBlobTierHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetBlobTier extends Binding.Service<
  SetBlobTier,
  "Azure.Storage.SetBlobTier",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetBlobTierRequest,
    ) => Effect.Effect<blob.SetBlobTierResponse, blob.SetBlobTierError, RuntimeContext>
  >
> {}

export const SetBlobTier = Binding.Service<SetBlobTier>("Azure.Storage.SetBlobTier");
