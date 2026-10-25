import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetBlobImmutabilityPolicy` request without the `url` and `containerName` the bound container supplies. */
export interface SetBlobImmutabilityPolicyRequest extends Omit<
  blob.SetBlobImmutabilityPolicyRequest,
  "url" | "containerName"
> {}

/**
 * Set a time-based retention policy on a blob (`Set Blob Immutability
 * Policy`). The container needs version-level immutability.
 *
 * Binding grants a custom role with only
 * `blobs/immutableStorage/runAsSuperUser/action`, assigned on the bound
 * container only. On a host with a managed identity (an Azure Function,
 * Function App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host gets an Entra
 * service principal with the role and its client secret in the host's env
 * (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetBlobImmutabilityPolicyHttp}.
 *
 * ### Immutability Policies
 * **Example:** Retain a blob for 7 days
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
 *     const setBlobImmutabilityPolicy = yield* Azure.Storage.SetBlobImmutabilityPolicy(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setBlobImmutabilityPolicy({
 *           blob: "evidence.pdf",
 *           xMsImmutabilityPolicyUntilDate: new Date(Date.now() + 7 * 86_400_000).toUTCString(),
 *           xMsImmutabilityPolicyMode: "Unlocked",
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetBlobImmutabilityPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetBlobImmutabilityPolicy extends Binding.Service<
  SetBlobImmutabilityPolicy,
  "Azure.Storage.SetBlobImmutabilityPolicy",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request: SetBlobImmutabilityPolicyRequest,
    ) => Effect.Effect<
      blob.SetBlobImmutabilityPolicyResponse,
      blob.SetBlobImmutabilityPolicyError,
      RuntimeContext
    >
  >
> {}

export const SetBlobImmutabilityPolicy = Binding.Service<SetBlobImmutabilityPolicy>(
  "Azure.Storage.SetBlobImmutabilityPolicy",
);
