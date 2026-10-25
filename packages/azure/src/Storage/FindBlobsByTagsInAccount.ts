import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `ServiceFilterBlobs` request without the `url` the bound account supplies. */
export interface FindBlobsByTagsInAccountRequest extends Omit<
  blob.ServiceFilterBlobsRequest,
  "url"
> {}

/**
 * Find blobs in every container of the account whose index tags match an
 * expression (`Find Blobs by Tags`).
 *
 * Binding grants a custom role with only `blobs/filter/action`, assigned on
 * the bound storage account (an account-level operation has no narrower
 * scope). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host gets an Entra
 * service principal with the role and its client secret in the host's env
 * (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link FindBlobsByTagsInAccountHttp}.
 *
 * ### Finding Blobs Across Containers
 * **Example:** Find a tenant's blobs
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *
 *     // init: bind the operation to the account
 *     const findBlobsByTagsInAccount = yield* Azure.Storage.FindBlobsByTagsInAccount(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account's Blob endpoint is injected
 *         const res = yield* findBlobsByTagsInAccount({ where: "\"tenant\"='acme'" });
 *         const hits = res.Blobs.map((b) => `${b.ContainerName}/${b.Name}`);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.FindBlobsByTagsInAccountHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface FindBlobsByTagsInAccount extends Binding.Service<
  FindBlobsByTagsInAccount,
  "Azure.Storage.FindBlobsByTagsInAccount",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: FindBlobsByTagsInAccountRequest,
    ) => Effect.Effect<
      blob.ServiceFilterBlobsResponse,
      blob.ServiceFilterBlobsError,
      RuntimeContext
    >
  >
> {}

export const FindBlobsByTagsInAccount = Binding.Service<FindBlobsByTagsInAccount>(
  "Azure.Storage.FindBlobsByTagsInAccount",
);
