import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetUpdateComplianceRequest extends Omit<
  adu.DeviceManagementGetUpdateComplianceRequest,
  "endpoint" | "instanceId"
> {}

/**
 * Get update compliance: `GET /deviceUpdate/{instance}/management/updateCompliance` on the Device Update data plane.
 *
 * Binding assigns a custom role (`AzureDeviceUpdateManagementReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.DeviceUpdate/accounts/instances/management/read`, on the bound
 * instance only (the built-in Device Update roles grant several data
 * actions each).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetUpdateComplianceHttp}.
 *
 * ### Calling GetUpdateCompliance
 * **Example:** GetUpdateCompliance from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const getUpdateCompliance = yield* Azure.DeviceUpdate.GetUpdateCompliance(instance);
 *
 * // runtime
 * const result = yield* getUpdateCompliance();
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.GetUpdateComplianceHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface GetUpdateCompliance extends Binding.Service<
  GetUpdateCompliance,
  "Azure.DeviceUpdate.GetUpdateCompliance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetUpdateComplianceRequest,
    ) => Effect.Effect<
      adu.UpdateCompliance,
      adu.DeviceManagementGetUpdateComplianceError,
      RuntimeContext
    >
  >
> {}

export const GetUpdateCompliance = Binding.Service<GetUpdateCompliance>(
  "Azure.DeviceUpdate.GetUpdateCompliance",
);
