import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface GetSnapshotRequest extends Omit<appconfig.GetSnapshotRequest, "endpoint"> {}

/**
 * Read one snapshot (a named, immutable set of key-values) of an Azure
 * App Configuration store. A missing snapshot fails with `NotFound`.
 *
 * Binding assigns a custom role (`AzureAppConfigurationSnapshotReadRole`, one per stack) with
 * exactly the data action `snapshots/read`, on the store only. The smallest
 * built-in role, **App Configuration Data Reader**, also reads key-values, feature flags, and schemas.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSnapshotHttp}.
 *
 * ### Calling GetSnapshot
 * **Example:** GetSnapshot from a Function
 * ```typescript
 * // init
 * const getSnapshot = yield* Azure.AppConfiguration.GetSnapshot(store);
 *
 * // runtime
 * const snapshot = yield* getSnapshot({ name: "release-1" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface GetSnapshot extends Binding.Service<
  GetSnapshot,
  "Azure.AppConfiguration.GetSnapshot",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: GetSnapshotRequest,
    ) => Effect.Effect<appconfig.GetSnapshotResponse, appconfig.GetSnapshotError, RuntimeContext>
  >
> {}

export const GetSnapshot = Binding.Service<GetSnapshot>("Azure.AppConfiguration.GetSnapshot");
