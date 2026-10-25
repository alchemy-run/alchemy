import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

export interface CreateSnapshotRequest extends Omit<appconfig.CreateSnapshotRequest, "endpoint"> {}

/**
 * Create a snapshot (a named, immutable set of key-values) of an Azure App
 * Configuration store from any host. The store builds it asynchronously:
 * the response has status `provisioning`; poll `GetSnapshot` (or
 * `GetOperationDetails`) until it is `ready`. A snapshot created here is not
 * tracked by `Azure.AppConfiguration.Snapshot`.
 *
 * Binding assigns a custom role (`AzureAppConfigurationSnapshotWriteRole`, one per stack) with
 * exactly the data action `snapshots/write`, on the store only. The smallest
 * built-in role, **App Configuration Data Owner**, grants every data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateSnapshotHttp}.
 *
 * ### Calling CreateSnapshot
 * **Example:** CreateSnapshot from a Function
 * ```typescript
 * // init
 * const createSnapshot = yield* Azure.AppConfiguration.CreateSnapshot(store);
 *
 * // runtime
 * const created = yield* createSnapshot({
 *   name: "release-1",
 *   filters: [{ key: "App:*", label: "prod" }],
 * });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "Azure.AppConfiguration.CreateSnapshot",
  (
    store: ConfigurationStore,
  ) => Effect.Effect<
    (
      request: CreateSnapshotRequest,
    ) => Effect.Effect<
      appconfig.CreateSnapshotResponse,
      appconfig.CreateSnapshotError,
      RuntimeContext
    >
  >
> {}

export const CreateSnapshot = Binding.Service<CreateSnapshot>(
  "Azure.AppConfiguration.CreateSnapshot",
);
