import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDeviceStatesForDeviceClassSubgroupDeploymentRequest extends Omit<
  adu.ListDeviceManagementDeviceStatesForDeviceClassSubgroupDeploymentRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List device states for device class subgroup deployment: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/deployments/{deploymentId}/devicestates` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListDeviceStatesForDeviceClassSubgroupDeploymentHttp}.
 *
 * ### Calling ListDeviceStatesForDeviceClassSubgroupDeployment
 * **Example:** ListDeviceStatesForDeviceClassSubgroupDeployment from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listDeviceStatesForDeviceClassSubgroupDeployment = yield* Azure.DeviceUpdate.ListDeviceStatesForDeviceClassSubgroupDeployment(instance);
 *
 * // runtime
 * const result = yield* listDeviceStatesForDeviceClassSubgroupDeployment(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListDeviceStatesForDeviceClassSubgroupDeploymentHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListDeviceStatesForDeviceClassSubgroupDeployment extends Binding.Service<
  ListDeviceStatesForDeviceClassSubgroupDeployment,
  "Azure.DeviceUpdate.ListDeviceStatesForDeviceClassSubgroupDeployment",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListDeviceStatesForDeviceClassSubgroupDeploymentRequest,
    ) => Effect.Effect<
      adu.DeploymentDeviceStatesList,
      adu.ListDeviceManagementDeviceStatesForDeviceClassSubgroupDeploymentError,
      RuntimeContext
    >
  >
> {}

export const ListDeviceStatesForDeviceClassSubgroupDeployment =
  Binding.Service<ListDeviceStatesForDeviceClassSubgroupDeployment>(
    "Azure.DeviceUpdate.ListDeviceStatesForDeviceClassSubgroupDeployment",
  );
