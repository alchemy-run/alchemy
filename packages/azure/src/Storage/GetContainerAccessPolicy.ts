import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** `GetContainerAccessPolicy` request without the `url` and `containerName` the bound container supplies. */
export interface GetContainerAccessPolicyRequest extends Omit<
  blob.GetContainerAccessPolicyRequest,
  "url" | "containerName"
> {}

/**
 * Read the container's stored access policies and public access level (`Get
 * Container ACL`).
 *
 * Binding grants a custom role with only `containers/getAcl/action`,
 * assigned on the bound container only. On a host with a managed identity
 * (an Azure Function, Function App, Web App, Container App, container group,
 * VM, or AKS workload identity) the role goes to that identity; any other
 * host gets an Entra service principal with the role and its client secret
 * in the host's env (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link GetContainerAccessPolicyHttp}.
 *
 * ### Reading Access Policies
 * **Example:** List stored access policies
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
 *     const getContainerAccessPolicy = yield* Azure.Storage.GetContainerAccessPolicy(files);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the container's URL and name are injected
 *         const acl = yield* getContainerAccessPolicy();
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetContainerAccessPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetContainerAccessPolicy extends Binding.Service<
  GetContainerAccessPolicy,
  "Azure.Storage.GetContainerAccessPolicy",
  (
    container: BlobContainer,
  ) => Effect.Effect<
    (
      request?: GetContainerAccessPolicyRequest,
    ) => Effect.Effect<
      blob.GetContainerAccessPolicyResponse,
      blob.GetContainerAccessPolicyError,
      RuntimeContext
    >
  >
> {}

export const GetContainerAccessPolicy = Binding.Service<GetContainerAccessPolicy>(
  "Azure.Storage.GetContainerAccessPolicy",
);
