import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListUpdateFilesRequest extends Omit<
  adu.ListDeviceUpdateFilesRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List update files: `GET /deviceUpdate/{instance}/updates/providers/{provider}/names/{name}/versions/{version}/files` on the Device Update data plane. One page per call: pass `nextLink` for the next.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateUpdatesReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/updates/read`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListUpdateFilesHttp}.
 *
 * ### Calling ListUpdateFiles
 * **Example:** ListUpdateFiles from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listUpdateFiles = yield* Azure.DeviceUpdate.ListUpdateFiles(instance);
 *
 * // runtime
 * const result = yield* listUpdateFiles(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListUpdateFilesHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListUpdateFiles extends Binding.Service<
  ListUpdateFiles,
  "Azure.DeviceUpdate.ListUpdateFiles",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListUpdateFilesRequest,
    ) => Effect.Effect<adu.StringsList, adu.ListDeviceUpdateFilesError, RuntimeContext>
  >
> {}

export const ListUpdateFiles = Binding.Service<ListUpdateFiles>(
  "Azure.DeviceUpdate.ListUpdateFiles",
);
