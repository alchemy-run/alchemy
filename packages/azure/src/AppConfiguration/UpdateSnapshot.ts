import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface UpdateSnapshotRequest extends Omit<appconfig.UpdateSnapshotRequest, "endpoint"> {}

/**
 * Archive a snapshot of an Azure App Configuration store (`status:
 * "archived"`), or recover an archived one (`status: "ready"`).
 *
 * Binding assigns a custom role (`AzureAppConfigurationSnapshotArchiveRole`, one per stack) with
 * exactly the data action `snapshots/archive/action`, on the store only. The smallest
 * built-in role, **App Configuration Data Owner**, grants every data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateSnapshotHttp}.
 *
 * ### Calling UpdateSnapshot
 * **Example:** UpdateSnapshot from a Function
 * ```typescript
 * // init
 * const updateSnapshot = yield* Azure.AppConfiguration.UpdateSnapshot(store);
 *
 * // runtime
 * const archived = yield* updateSnapshot({ name: "release-1", status: "archived" });
 * // …provided with Effect.provide(Azure.AppConfiguration.UpdateSnapshotHttp)
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface UpdateSnapshot extends Binding.Service<
  UpdateSnapshot,
  "Azure.AppConfiguration.UpdateSnapshot",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: UpdateSnapshotRequest,
    ) => Effect.Effect<
      appconfig.UpdateSnapshotResponse,
      appconfig.UpdateSnapshotError,
      RuntimeContext
    >
  >
> {}

export const UpdateSnapshot = Binding.Service<UpdateSnapshot>(
  "Azure.AppConfiguration.UpdateSnapshot",
);
