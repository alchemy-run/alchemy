import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface CheckSnapshotRequest extends Omit<appconfig.CheckSnapshotRequest, "endpoint"> {}

/**
 * Check that one snapshot of an Azure App Configuration store exists
 * (`HEAD`, no body). A missing snapshot fails with `NotFound`.
 *
 * Binding assigns a custom role (`AzureAppConfigurationSnapshotReadRole`, one per stack) with
 * exactly the data action `snapshots/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads key-values, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CheckSnapshotHttp}.
 *
 * ### Calling CheckSnapshot
 * **Example:** CheckSnapshot from a Function
 * ```typescript
 * // init
 * const checkSnapshot = yield* Azure.AppConfiguration.CheckSnapshot(store);
 *
 * // runtime
 * yield* checkSnapshot({ name: "release-1" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface CheckSnapshot extends Binding.Service<
  CheckSnapshot,
  "Azure.AppConfiguration.CheckSnapshot",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: CheckSnapshotRequest,
    ) => Effect.Effect<
      appconfig.CheckSnapshotResponse,
      appconfig.CheckSnapshotError,
      RuntimeContext
    >
  >
> {}

export const CheckSnapshot = Binding.Service<CheckSnapshot>("Azure.AppConfiguration.CheckSnapshot");
