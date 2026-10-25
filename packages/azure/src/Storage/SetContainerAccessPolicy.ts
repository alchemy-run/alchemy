import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `SetContainerAccessPolicy` request without the `url` and `containerName` the bound container supplies. */
export interface SetContainerAccessPolicyRequest extends Omit<
  blob.SetContainerAccessPolicyRequest,
  "url" | "containerName"
> {}

/**
 * Replace the container's stored access policies (`Set Container ACL`).
 *
 * Binding grants a custom role with only `containers/setAcl/action`,
 * assigned on the bound container only. On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container group,
 * VM, or AKS workload identity) the role goes to that identity; any other
 * host gets an Entra service principal with the role and its client secret
 * in the host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetContainerAccessPolicyHttp}.
 *
 * ### Writing Access Policies
 * **Example:** Add a read-only stored access policy
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
 *     const setContainerAccessPolicy = yield* Azure.Storage.SetContainerAccessPolicy(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         yield* setContainerAccessPolicy({
 *           body: [
 *             {
 *               Id: "readers",
 *               AccessPolicy: { Start: start, Expiry: expiry, Permission: "r" },
 *             },
 *           ],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetContainerAccessPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetContainerAccessPolicy extends Binding.Service<
  SetContainerAccessPolicy,
  "Azure.Storage.SetContainerAccessPolicy",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request?: SetContainerAccessPolicyRequest,
    ) => Effect.Effect<
      blob.SetContainerAccessPolicyResponse,
      blob.SetContainerAccessPolicyError,
      RuntimeContext
    >
  >
> {}

export const SetContainerAccessPolicy = Binding.Service<SetContainerAccessPolicy>(
  "Azure.Storage.SetContainerAccessPolicy",
);
