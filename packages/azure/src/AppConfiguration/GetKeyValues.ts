import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface GetKeyValuesRequest extends Omit<appconfig.GetKeyValuesRequest, "endpoint"> {}

/**
 * List one page of the key-values of an Azure App Configuration store,
 * filtered by key, label, or tags. Pass the page's `_nextLink` as `nextLink`
 * for the next page.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetKeyValuesHttp}.
 *
 * ### Calling GetKeyValues
 * **Example:** GetKeyValues from a Function
 * ```typescript
 * // init
 * const getKeyValues = yield* Azure.AppConfiguration.GetKeyValues(store);
 *
 * // runtime
 * const page = yield* getKeyValues({ key: "App:*", label: "prod" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface GetKeyValues extends Binding.Service<
  GetKeyValues,
  "Azure.AppConfiguration.GetKeyValues",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: GetKeyValuesRequest,
    ) => Effect.Effect<appconfig.KeyValueListResult, appconfig.GetKeyValuesError, RuntimeContext>
  >
> {}

export const GetKeyValues = Binding.Service<GetKeyValues>("Azure.AppConfiguration.GetKeyValues");
