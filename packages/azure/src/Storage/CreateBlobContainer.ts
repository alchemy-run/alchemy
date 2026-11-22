import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `CreateContainer` request without the `url` the bound account supplies. */
export interface CreateBlobContainerRequest extends Omit<blob.CreateContainerRequest, "url"> {}

/**
 * Create a blob container at runtime, e.g. one per tenant (`Create
 * Container`). Alchemy does not track it; declare long-lived containers with
 * `Azure.Storage.BlobContainer`.
 *
 * Binding grants a custom role with only `containers/write`, assigned on the
 * bound storage account (an account-level operation has no narrower scope).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host gets an Entra service principal
 * with the role and its client secret in the host's env (see
 * `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link CreateBlobContainerHttp}.
 *
 * ### Creating Containers
 * **Example:** Create a container per tenant
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *
 *     // init: bind the operation to the account
 *     const createBlobContainer = yield* Azure.Storage.CreateBlobContainer(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account's Blob endpoint is injected
 *         yield* createBlobContainer({ containerName: `tenant-${tenantId}` });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.CreateBlobContainerHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface CreateBlobContainer extends Binding.Service<
  CreateBlobContainer,
  "Azure.Storage.CreateBlobContainer",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request: CreateBlobContainerRequest,
    ) => Effect.Effect<blob.CreateContainerResponse, blob.CreateContainerError, RuntimeContext>
  >
> {}

export const CreateBlobContainer = Binding.Service<CreateBlobContainer>(
  "Azure.Storage.CreateBlobContainer",
);
