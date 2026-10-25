import * as vmware from "@distilled.cloud/azure/vmware";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  AVS_NAMESPACE,
  WORKLOAD_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameSet,
} from "./common.ts";

export interface WorkloadNetworkVMGroupProps {
  /**
   * Resource group of the private cloud. Changing it replaces the VM group.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the VM group. */
  privateCloud: string;
  /**
   * NSX ID of the VM group. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the VM group.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Display name of the VM group.
   * @default not set
   */
  displayName?: string;
  /**
   * NSX virtual machine IDs in the group.
   * @default not set
   */
  members?: string[];
}

export interface WorkloadNetworkVMGroup extends Resource<
  "Azure.VMware.WorkloadNetworkVMGroup",
  WorkloadNetworkVMGroupProps,
  {
    /** NSX ID of the VM group. */
    vmGroupName: string;
    /** ARM resource ID of the VM group. */
    vmGroupResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** Group status (`SUCCESS` or `FAILURE`). */
    status: string | undefined;
    /** Virtual machine members of the group. */
    members: string[];
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An NSX-T VM group in an Azure VMware Solution private cloud
 * (`Microsoft.AVS/privateClouds/workloadNetworks/vmGroups`), used as the
 * source or destination of port mirroring and in distributed firewall rules.
 *
 * :::caution
 * Changing `privateCloud`, `name`, or `resourceGroup` replaces the VM group.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/configure-port-mirroring-azure-vmware-solution
 *
 * ### Grouping VMs
 * **Example:** VM group with two members
 * ```typescript
 * const cloud = yield* Azure.VMware.PrivateCloud("cloud", {
 *   sku: "av36p",
 *   networkBlock: "10.175.0.0/22",
 *   clusterSize: 3,
 * });
 * yield* Azure.VMware.WorkloadNetworkVMGroup("web", {
 *   privateCloud: cloud.privateCloudName,
 *   displayName: "web-servers",
 *   members: [
 *     "50326c6d-1f2a-4b3c-8d4e-5f6a7b8c9d01",
 *     "50326c6d-1f2a-4b3c-8d4e-5f6a7b8c9d02",
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const WorkloadNetworkVMGroup = GroupedResource<WorkloadNetworkVMGroup>(
  "Azure.VMware.WorkloadNetworkVMGroup",
);

const createName = (id: string) => createAvsName(id, 64);

const getWorkloadNetworkVMGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  vmGroupId: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetWorkloadNetworkVMGroup({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      vmGroupId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetWorkloadNetworkVMGroupResponse,
): WorkloadNetworkVMGroup["Attributes"] => ({
  vmGroupName: name,
  vmGroupResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  status: observed.properties?.status,
  members: [...(observed.properties?.members ?? [])],
  provisioningState: observed.properties?.provisioningState,
});

const desired = (news: WorkloadNetworkVMGroupProps) => ({
  displayName: news.displayName,
  members: news.members,
});

export const WorkloadNetworkVMGroupProvider = () =>
  Provider.succeed(WorkloadNetworkVMGroup, {
    stables: ["vmGroupName", "vmGroupResourceId", "resourceGroup", "privateCloud"],

    // Lives inside a private cloud; nuke removes it with the private cloud.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.vmGroupName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateCloud = output?.privateCloud ?? olds?.privateCloud;
      if (resourceGroup === undefined || privateCloud === undefined) {
        return undefined;
      }
      const name = output?.vmGroupName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getWorkloadNetworkVMGroup(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, privateCloud, name, observed);
      return (yield* isPrivateCloudOwnedByStack(subscriptionId, resourceGroup, privateCloud))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud } = news;
      const name = news.name ?? output?.vmGroupName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        vmGroupId: name,
      };
      const get = getWorkloadNetworkVMGroup(subscriptionId, resourceGroup, privateCloud, name);
      const wait = () =>
        waitForProvisioned(
          `AVS NSX VM group ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          WORKLOAD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.CreateWorkloadNetworkVMGroup({
          ...where,
          properties: desired(news),
        });
      }
      observed = yield* wait();

      // Sync mutable fields against the observed NSX object. NSX uses the
      // revision for optimistic concurrency, so send back the observed one.
      const props = observed.properties;
      if (
        (news.displayName !== undefined && props?.displayName !== news.displayName) ||
        (news.members !== undefined && !sameSet(props?.members, news.members))
      ) {
        yield* vmware.UpdateWorkloadNetworkVMGroup({
          ...where,
          properties: { ...desired(news), revision: props?.revision },
        });
        observed = yield* wait();
      }

      return toAttrs(resourceGroup, privateCloud, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteWorkloadNetworkVMGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          vmGroupId: output.vmGroupName,
        }),
      );
      yield* waitUntilGone(
        `AVS NSX VM group ${output.vmGroupName}`,
        getWorkloadNetworkVMGroup(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.vmGroupName,
        ),
        WORKLOAD_BUDGET,
      );
    }),
  });
