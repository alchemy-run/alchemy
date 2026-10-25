import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface CheckKeyValuesRequest extends Omit<appconfig.CheckKeyValuesRequest, "endpoint"> {}

/**
 * Check the key-value list of an Azure App Configuration store (`HEAD`,
 * no body), e.g. to test a filter or an ETag.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CheckKeyValuesHttp}.
 *
 * ### Calling CheckKeyValues
 * **Example:** CheckKeyValues from a Function
 * ```typescript
 * // init
 * const checkKeyValues = yield* Azure.AppConfiguration.CheckKeyValues(store);
 *
 * // runtime
 * yield* checkKeyValues({ key: "App:*" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface CheckKeyValues extends Binding.Service<
  CheckKeyValues,
  "Azure.AppConfiguration.CheckKeyValues",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: CheckKeyValuesRequest,
    ) => Effect.Effect<
      appconfig.CheckKeyValuesResponse,
      appconfig.CheckKeyValuesError,
      RuntimeContext
    >
  >
> {}

export const CheckKeyValues = Binding.Service<CheckKeyValues>(
  "Azure.AppConfiguration.CheckKeyValues",
);
