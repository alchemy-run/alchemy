import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface CheckLabelsRequest extends Omit<appconfig.CheckLabelsRequest, "endpoint"> {}

/**
 * Check the label list of an Azure App Configuration store (`HEAD`, no body).
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CheckLabelsHttp}.
 *
 * ### Calling CheckLabels
 * **Example:** CheckLabels from a Function
 * ```typescript
 * // init
 * const checkLabels = yield* Azure.AppConfiguration.CheckLabels(store);
 *
 * // runtime
 * yield* checkLabels({ name: "prod*" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface CheckLabels extends Binding.Service<
  CheckLabels,
  "Azure.AppConfiguration.CheckLabels",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: CheckLabelsRequest,
    ) => Effect.Effect<appconfig.CheckLabelsResponse, appconfig.CheckLabelsError, RuntimeContext>
  >
> {}

export const CheckLabels = Binding.Service<CheckLabels>("Azure.AppConfiguration.CheckLabels");
