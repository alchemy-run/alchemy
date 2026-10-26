import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface CheckRevisionsRequest extends Omit<appconfig.CheckRevisionsRequest, "endpoint"> {}

/**
 * Check the revision list of an Azure App Configuration store (`HEAD`, no body).
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CheckRevisionsHttp}.
 *
 * ### Calling CheckRevisions
 * **Example:** CheckRevisions from a Function
 * ```typescript
 * // init
 * const checkRevisions = yield* Azure.AppConfiguration.CheckRevisions(store);
 *
 * // runtime
 * yield* checkRevisions({ key: "App:Color" });
 * // …provided with Effect.provide(Azure.AppConfiguration.CheckRevisionsHttp)
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface CheckRevisions extends Binding.Service<
  CheckRevisions,
  "Azure.AppConfiguration.CheckRevisions",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: CheckRevisionsRequest,
    ) => Effect.Effect<
      appconfig.CheckRevisionsResponse,
      appconfig.CheckRevisionsError,
      RuntimeContext
    >
  >
> {}

export const CheckRevisions = Binding.Service<CheckRevisions>(
  "Azure.AppConfiguration.CheckRevisions",
);
