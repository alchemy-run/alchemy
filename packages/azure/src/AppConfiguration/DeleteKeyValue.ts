import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface DeleteKeyValueRequest extends Omit<appconfig.DeleteKeyValueRequest, "endpoint"> {}

/**
 * Delete one key-value (setting) of an Azure App Configuration store from
 * any host. A locked key-value cannot be deleted.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueDeleteRole`, one per stack) with
 * exactly the data action `keyValues/delete`, on the store only. The smallest
 * built-in role, **App Configuration Data Owner**, grants every data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteKeyValueHttp}.
 *
 * ### Calling DeleteKeyValue
 * **Example:** DeleteKeyValue from a Function
 * ```typescript
 * // init
 * const deleteKeyValue = yield* Azure.AppConfiguration.DeleteKeyValue(store);
 *
 * // runtime
 * yield* deleteKeyValue({ key: "App:Legacy", label: "prod" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface DeleteKeyValue extends Binding.Service<
  DeleteKeyValue,
  "Azure.AppConfiguration.DeleteKeyValue",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: DeleteKeyValueRequest,
    ) => Effect.Effect<
      appconfig.DeleteKeyValueResponse,
      appconfig.DeleteKeyValueError,
      RuntimeContext
    >
  >
> {}

export const DeleteKeyValue = Binding.Service<DeleteKeyValue>(
  "Azure.AppConfiguration.DeleteKeyValue",
);
