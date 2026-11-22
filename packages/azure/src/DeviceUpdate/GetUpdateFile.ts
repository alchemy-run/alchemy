import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUpdateFileRequest extends Omit<
  adu.GetDeviceUpdateFileRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get update file: `GET /deviceUpdate/{instance}/updates/providers/{provider}/names/{name}/versions/{version}/files/{fileId}` on the Device Update data plane.
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
 * Provide {@link GetUpdateFileHttp}.
 *
 * ### Calling GetUpdateFile
 * **Example:** GetUpdateFile from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getUpdateFile = yield* Azure.DeviceUpdate.GetUpdateFile(instance);
 *
 * // runtime
 * const result = yield* getUpdateFile(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetUpdateFileHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetUpdateFile extends Binding.Service<
  GetUpdateFile,
  "Azure.DeviceUpdate.GetUpdateFile",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetUpdateFileRequest,
    ) => Effect.Effect<
      adu.GetDeviceUpdateFileResponse,
      adu.GetDeviceUpdateFileError,
      RuntimeContext
    >
  >
> {}

export const GetUpdateFile = Binding.Service<GetUpdateFile>("Azure.DeviceUpdate.GetUpdateFile");
