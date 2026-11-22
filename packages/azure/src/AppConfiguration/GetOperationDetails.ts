import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface GetOperationDetailsRequest extends Omit<
  appconfig.GetOperationDetailsRequest,
  "endpoint"
> {}

/**
 * Read the state of a snapshot's creation (a long-running operation) in an
 * Azure App Configuration store.
 *
 * Binding assigns a custom role (`AzureAppConfigurationSnapshotReadRole`, one per stack) with
 * exactly the data action `snapshots/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads key-values, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetOperationDetailsHttp}.
 *
 * ### Calling GetOperationDetails
 * **Example:** GetOperationDetails from a Function
 * ```typescript
 * // init
 * const getOperationDetails = yield* Azure.AppConfiguration.GetOperationDetails(store);
 *
 * // runtime
 * const operation = yield* getOperationDetails({ snapshot: "release-1" });
 * // …provided with Effect.provide(Azure.AppConfiguration.GetOperationDetailsHttp)
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface GetOperationDetails extends Binding.Service<
  GetOperationDetails,
  "Azure.AppConfiguration.GetOperationDetails",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: GetOperationDetailsRequest,
    ) => Effect.Effect<
      appconfig.OperationDetails,
      appconfig.GetOperationDetailsError,
      RuntimeContext
    >
  >
> {}

export const GetOperationDetails = Binding.Service<GetOperationDetails>(
  "Azure.AppConfiguration.GetOperationDetails",
);
