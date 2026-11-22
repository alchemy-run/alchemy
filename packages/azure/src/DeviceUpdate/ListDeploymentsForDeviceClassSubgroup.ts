import type * as adu from "@distilled.cloud/azure/deviceupdate-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDeploymentsForDeviceClassSubgroupRequest extends Omit<
  adu.ListDeviceManagementDeploymentsForDeviceClassSubgroupRequest,
  "endpoint" | "instanceId"
> {}

/**
 * List deployments for device class subgroup: `GET /deviceUpdate/{instance}/management/groups/{groupId}/deviceClassSubgroups/{deviceClassId}/deployments` on the Device Update data plane. One page per call: pass `nextLink` for the next.
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
 * Provide {@link ListDeploymentsForDeviceClassSubgroupHttp}.
 *
 * ### Calling ListDeploymentsForDeviceClassSubgroup
 * **Example:** ListDeploymentsForDeviceClassSubgroup from a Function
 * ```typescript
 * // init
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", { account: account.accountName, iotHubs: [hub.iotHubId] });
 * const listDeploymentsForDeviceClassSubgroup = yield* Azure.DeviceUpdate.ListDeploymentsForDeviceClassSubgroup(instance);
 *
 * // runtime
 * const result = yield* listDeploymentsForDeviceClassSubgroup(request);
 *
 * // layer
 * Effect.provide(Azure.DeviceUpdate.ListDeploymentsForDeviceClassSubgroupHttp)
 * ```
 *
 * @binding
 * @category DeviceUpdate
 */
export interface ListDeploymentsForDeviceClassSubgroup extends Binding.Service<
  ListDeploymentsForDeviceClassSubgroup,
  "Azure.DeviceUpdate.ListDeploymentsForDeviceClassSubgroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListDeploymentsForDeviceClassSubgroupRequest,
    ) => Effect.Effect<
      adu.DeploymentsList,
      adu.ListDeviceManagementDeploymentsForDeviceClassSubgroupError,
      RuntimeContext
    >
  >
> {}

export const ListDeploymentsForDeviceClassSubgroup =
  Binding.Service<ListDeploymentsForDeviceClassSubgroup>(
    "Azure.DeviceUpdate.ListDeploymentsForDeviceClassSubgroup",
  );
