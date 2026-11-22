import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `ListServiceContainersSegment` request without the `url` the bound account supplies. */
export interface ListBlobContainersRequest extends Omit<
  blob.ListServiceContainersSegmentRequest,
  "url"
> {}

/**
 * List one page of the account's blob containers (`List Containers`).
 *
 * Binding grants a custom role with only `containers/read`, assigned on the
 * bound storage account (an account-level operation has no narrower scope).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host gets an Entra service principal
 * with the role and its client secret in the host's env (see
 * `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link ListBlobContainersHttp}.
 *
 * ### Listing Containers
 * **Example:** List containers by prefix
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *
 *     // init: bind the operation to the account
 *     const listBlobContainers = yield* Azure.Storage.ListBlobContainers(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account's Blob endpoint is injected
 *         const page = yield* listBlobContainers({ prefix: "tenant-" });
 *         const names = page.ContainerItems.map((c) => c.Name);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.ListBlobContainersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface ListBlobContainers extends Binding.Service<
  ListBlobContainers,
  "Azure.Storage.ListBlobContainers",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: ListBlobContainersRequest,
    ) => Effect.Effect<
      blob.ListServiceContainersSegmentResponse,
      blob.ListServiceContainersSegmentError,
      RuntimeContext
    >
  >
> {}

export const ListBlobContainers = Binding.Service<ListBlobContainers>(
  "Azure.Storage.ListBlobContainers",
);
