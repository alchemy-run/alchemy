import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface CheckSnapshotsRequest extends Omit<appconfig.CheckSnapshotsRequest, "endpoint"> {}

/**
 * Check the snapshot list of an Azure App Configuration store (`HEAD`, no body).
 *
 * Binding assigns a custom role (`AzureAppConfigurationSnapshotReadRole`, one per stack) with
 * exactly the data action `snapshots/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads key-values, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CheckSnapshotsHttp}.
 *
 * ### Calling CheckSnapshots
 * **Example:** CheckSnapshots from a Function
 * ```typescript
 * // init
 * const checkSnapshots = yield* Azure.AppConfiguration.CheckSnapshots(store);
 *
 * // runtime
 * yield* checkSnapshots();
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface CheckSnapshots extends Binding.Service<
  CheckSnapshots,
  "Azure.AppConfiguration.CheckSnapshots",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request?: CheckSnapshotsRequest,
    ) => Effect.Effect<
      appconfig.CheckSnapshotsResponse,
      appconfig.CheckSnapshotsError,
      RuntimeContext
    >
  >
> {}

export const CheckSnapshots = Binding.Service<CheckSnapshots>(
  "Azure.AppConfiguration.CheckSnapshots",
);
