import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface GetKeysRequest extends Omit<appconfig.GetKeysRequest, "endpoint"> {}

/**
 * List one page of the distinct keys of an Azure App Configuration store,
 * optionally filtered by name.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetKeysHttp}.
 *
 * ### Calling GetKeys
 * **Example:** GetKeys from a Function
 * ```typescript
 * // init
 * const getKeys = yield* Azure.AppConfiguration.GetKeys(store);
 *
 * // runtime
 * const page = yield* getKeys({ name: "App:*" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface GetKeys extends Binding.Service<
  GetKeys,
  "Azure.AppConfiguration.GetKeys",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: GetKeysRequest,
    ) => Effect.Effect<appconfig.KeyListResult, appconfig.GetKeysError, RuntimeContext>
  >
> {}

export const GetKeys = Binding.Service<GetKeys>("Azure.AppConfiguration.GetKeys");
