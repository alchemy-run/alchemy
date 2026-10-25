import type * as blob from "@distilled.cloud/azure/storage-blob";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StorageAccount } from "./StorageAccount.ts";

/** `SetServiceProperties` request without the `url` the bound account supplies. */
export interface SetBlobServicePropertiesRequest extends Omit<
  blob.SetServicePropertiesRequest,
  "url"
> {}

/**
 * Set the account's Blob service properties; elements you leave out keep
 * their values (`Set Blob Service Properties`). Do not set what an
 * `Azure.Storage.BlobServiceProperties` resource manages.
 *
 * Binding grants a custom role with only `blobServices/write`, assigned on
 * the bound storage account (an account-level operation has no narrower
 * scope). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host gets an Entra
 * service principal with the role and its client secret in the host's env
 * (see `AzureBindings`). The custom role is an
 * `Azure.Authorization.RoleDefinition` created once per stack and shared by
 * every host. Provide {@link SetBlobServicePropertiesHttp}.
 *
 * ### Writing Service Properties
 * **Example:** Enable hourly metrics
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Azure.Storage.StorageAccount("Data");
 *
 *     // init: bind the operation to the account
 *     const setBlobServiceProperties = yield* Azure.Storage.SetBlobServiceProperties(account);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: the account's Blob endpoint is injected
 *         yield* setBlobServiceProperties({
 *           HourMetrics: { Version: "1.0", Enabled: true, IncludeAPIs: true, RetentionPolicy: { Enabled: true, Days: 7 } },
 *         });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.SetBlobServicePropertiesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SetBlobServiceProperties extends Binding.Service<
  SetBlobServiceProperties,
  "Azure.Storage.SetBlobServiceProperties",
  (
    account: StorageAccount,
  ) => Effect.Effect<
    (
      request?: SetBlobServicePropertiesRequest,
    ) => Effect.Effect<
      blob.SetServicePropertiesResponse,
      blob.SetServicePropertiesError,
      RuntimeContext
    >
  >
> {}

export const SetBlobServiceProperties = Binding.Service<SetBlobServiceProperties>(
  "Azure.Storage.SetBlobServiceProperties",
);
