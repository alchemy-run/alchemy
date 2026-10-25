import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface PutKeyValueRequest extends Omit<appconfig.PutKeyValueRequest, "endpoint"> {}

/**
 * Create or replace one key-value (setting) of an Azure App Configuration
 * store from any host. Pass `ifMatch` / `ifNoneMatch` for an optimistic
 * write. A key-value written here is not tracked by
 * `Azure.AppConfiguration.KeyValue`.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueWriteRole`, one per stack) with
 * exactly the data action `keyValues/write`, on the store only. The smallest
 * built-in role, **App Configuration Data Owner**, grants every data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link PutKeyValueHttp}.
 *
 * ### Calling PutKeyValue
 * **Example:** PutKeyValue from a Function
 * ```typescript
 * // init
 * const putKeyValue = yield* Azure.AppConfiguration.PutKeyValue(store);
 *
 * // runtime
 * const written = yield* putKeyValue({ key: "App:Color", label: "prod", value: "green" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface PutKeyValue extends Binding.Service<
  PutKeyValue,
  "Azure.AppConfiguration.PutKeyValue",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: PutKeyValueRequest,
    ) => Effect.Effect<appconfig.PutKeyValueResponse, appconfig.PutKeyValueError, RuntimeContext>
  >
> {}

export const PutKeyValue = Binding.Service<PutKeyValue>("Azure.AppConfiguration.PutKeyValue");
