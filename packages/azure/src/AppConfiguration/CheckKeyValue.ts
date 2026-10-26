import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface CheckKeyValueRequest extends Omit<appconfig.CheckKeyValueRequest, "endpoint"> {}

/**
 * Check that one key-value of an Azure App Configuration store exists
 * (`HEAD`, no body). A missing key fails with `NotFound`.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CheckKeyValueHttp}.
 *
 * ### Calling CheckKeyValue
 * **Example:** CheckKeyValue from a Function
 * ```typescript
 * // init
 * const checkKeyValue = yield* Azure.AppConfiguration.CheckKeyValue(store);
 *
 * // runtime
 * yield* checkKeyValue({ key: "App:Color", label: "prod" });
 * // …provided with Effect.provide(Azure.AppConfiguration.CheckKeyValueHttp)
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface CheckKeyValue extends Binding.Service<
  CheckKeyValue,
  "Azure.AppConfiguration.CheckKeyValue",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: CheckKeyValueRequest,
    ) => Effect.Effect<
      appconfig.CheckKeyValueResponse,
      appconfig.CheckKeyValueError,
      RuntimeContext
    >
  >
> {}

export const CheckKeyValue = Binding.Service<CheckKeyValue>("Azure.AppConfiguration.CheckKeyValue");
