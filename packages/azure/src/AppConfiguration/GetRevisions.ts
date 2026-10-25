import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface GetRevisionsRequest extends Omit<appconfig.GetRevisionsRequest, "endpoint"> {}

/**
 * List one page of the key-value revisions (the change history) of an
 * Azure App Configuration store, filtered by key, label, or tags.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`, one per stack) with
 * exactly the data action `keyValues/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads snapshots, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetRevisionsHttp}.
 *
 * ### Calling GetRevisions
 * **Example:** GetRevisions from a Function
 * ```typescript
 * // init
 * const getRevisions = yield* Azure.AppConfiguration.GetRevisions(store);
 *
 * // runtime
 * const page = yield* getRevisions({ key: "App:Color" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface GetRevisions extends Binding.Service<
  GetRevisions,
  "Azure.AppConfiguration.GetRevisions",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: GetRevisionsRequest,
    ) => Effect.Effect<appconfig.KeyValueListResult, appconfig.GetRevisionsError, RuntimeContext>
  >
> {}

export const GetRevisions = Binding.Service<GetRevisions>("Azure.AppConfiguration.GetRevisions");
