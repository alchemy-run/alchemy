import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `GetServiceProperties` request without the `url` the bound account supplies. */
export interface GetBlobServicePropertiesRequest extends Omit<
  blob.GetServicePropertiesRequest,
  "url"
> {}

/**
 * Read the account's Blob service properties: CORS, logging, metrics, soft
 * delete, and static website (`Get Blob Service Properties`).
 *
 * Binding grants a custom role with only `blobServices/read`, assigned on
 * the bound storage account (an account-level operation has no narrower
 * scope). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host gets an Entra
 * service principal with the role and its client secret in the host's env
 * (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link GetBlobServicePropertiesHttp}.
 *
 * ### Reading Service Properties
 * **Example:** Read the soft delete policy
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *
 *     // init: bind the operation to the account
 *     const getBlobServiceProperties = yield* Azure.Storage.GetBlobServiceProperties(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account's Blob endpoint is injected
 *         const props = yield* getBlobServiceProperties();
 *         const retention = props.DeleteRetentionPolicy;
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.GetBlobServicePropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface GetBlobServiceProperties extends Binding.Service<
  GetBlobServiceProperties,
  "Azure.Storage.GetBlobServiceProperties",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: GetBlobServicePropertiesRequest,
    ) => Effect.Effect<
      blob.GetServicePropertiesResponse,
      blob.GetServicePropertiesError,
      RuntimeContext
    >
  >
> {}

export const GetBlobServiceProperties = Binding.Service<GetBlobServiceProperties>(
  "Azure.Storage.GetBlobServiceProperties",
);
