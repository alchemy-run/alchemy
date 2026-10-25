import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface GetLabelsRequest extends Omit<appconfig.GetLabelsRequest, "endpoint"> {}

/**
 * List one page of the labels used in an Azure App Configuration store,
 * optionally filtered by name.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetLabelsHttp}.
 *
 * ### Calling GetLabels
 * **Example:** GetLabels from a Function
 * ```typescript
 * // init
 * const getLabels = yield* Azure.AppConfiguration.GetLabels(store);
 *
 * // runtime
 * const page = yield* getLabels({ name: "prod*" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface GetLabels extends Binding.Service<
  GetLabels,
  "Azure.AppConfiguration.GetLabels",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: GetLabelsRequest,
    ) => Effect.Effect<appconfig.LabelListResult, appconfig.GetLabelsError, RuntimeContext>
  >
> {}

export const GetLabels = Binding.Service<GetLabels>("Azure.AppConfiguration.GetLabels");
