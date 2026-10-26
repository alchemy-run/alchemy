import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface GetKeyValueRequest extends Omit<appconfig.GetKeyValueRequest, "endpoint"> {}

/**
 * Read one key-value (setting) of an Azure App Configuration store from any host.
 * A missing key fails with `NotFound`.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetKeyValueHttp}.
 *
 * ### Calling GetKeyValue
 * **Example:** GetKeyValue from a Function
 * ```typescript
 * // init
 * const getKeyValue = yield* Azure.AppConfiguration.GetKeyValue(store);
 *
 * // runtime
 * const setting = yield* getKeyValue({ key: "App:Color", label: "prod" });
 * // …provided with Effect.provide(Azure.AppConfiguration.GetKeyValueHttp)
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface GetKeyValue extends Binding.Service<
  GetKeyValue,
  "Azure.AppConfiguration.GetKeyValue",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: GetKeyValueRequest,
    ) => Effect.Effect<appconfig.GetKeyValueResponse, appconfig.GetKeyValueError, RuntimeContext>
  >
> {}

export const GetKeyValue = Binding.Service<GetKeyValue>("Azure.AppConfiguration.GetKeyValue");
