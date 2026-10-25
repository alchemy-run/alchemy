import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface GetSnapshotsRequest extends Omit<appconfig.GetSnapshotsRequest, "endpoint"> {}

/**
 * List one page of the snapshots of an Azure App Configuration store,
 * optionally filtered by name or status.
 *
 * Binding assigns a custom role (`AzureAppConfigurationSnapshotReadRole`, one per stack) with
 * exactly the data action `snapshots/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads key-values, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSnapshotsHttp}.
 *
 * ### Calling GetSnapshots
 * **Example:** GetSnapshots from a Function
 * ```typescript
 * // init
 * const getSnapshots = yield* Azure.AppConfiguration.GetSnapshots(store);
 *
 * // runtime
 * const page = yield* getSnapshots({ status: ["ready"] });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface GetSnapshots extends Binding.Service<
  GetSnapshots,
  "Azure.AppConfiguration.GetSnapshots",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: GetSnapshotsRequest,
    ) => Effect.Effect<appconfig.SnapshotListResult, appconfig.GetSnapshotsError, RuntimeContext>
  >
> {}

export const GetSnapshots = Binding.Service<GetSnapshots>("Azure.AppConfiguration.GetSnapshots");
