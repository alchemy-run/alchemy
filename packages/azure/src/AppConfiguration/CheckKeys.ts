import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface CheckKeysRequest extends Omit<appconfig.CheckKeysRequest, "endpoint"> {}

/**
 * Check the key list of an Azure App Configuration store (`HEAD`, no body).
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CheckKeysHttp}.
 *
 * ### Calling CheckKeys
 * **Example:** CheckKeys from a Function
 * ```typescript
 * // init
 * const checkKeys = yield* Azure.AppConfiguration.CheckKeys(store);
 *
 * // runtime
 * yield* checkKeys({ name: "App:*" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface CheckKeys extends Binding.Service<
  CheckKeys,
  "Azure.AppConfiguration.CheckKeys",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: CheckKeysRequest,
    ) => Effect.Effect<appconfig.CheckKeysResponse, appconfig.CheckKeysError, RuntimeContext>
  >
> {}

export const CheckKeys = Binding.Service<CheckKeys>("Azure.AppConfiguration.CheckKeys");
