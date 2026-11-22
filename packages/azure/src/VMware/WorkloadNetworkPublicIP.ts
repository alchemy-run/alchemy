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
} from "./common.ts";

export interface WorkloadNetworkPublicIPProps {
  /**
   * Resource group of the private cloud. Changing it replaces the public IP block.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the public IP block. */
  privateCloud: string;
  /**
   * NSX ID of the public IP block. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the public IP block.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Number of public IPs to allocate. Changing it replaces the block.
   */
  numberOfPublicIPs: number;
  /**
   * Display name of the block. Changing it replaces the block.
   * @default not set
   */
  displayName?: string;
}

export interface WorkloadNetworkPublicIP extends Resource<
  "Azure.VMware.WorkloadNetworkPublicIP",
  WorkloadNetworkPublicIPProps,
  {
    /** NSX ID of the public IP block. */
    publicIPName: string;
    /** ARM resource ID of the public IP block. */
    publicIPResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** CIDR of the allocated public IP block. */
    publicIPBlock: string | undefined;
    /** Number of public IPs in the block. */
    numberOfPublicIPs: number | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A block of public IPs allocated to the NSX edge of an Azure VMware
 * Solution private cloud
 * (`Microsoft.AVS/privateClouds/workloadNetworks/publicIPs`), for
 * inbound/outbound internet on workload VMs.
 *
 * :::caution
 * Changing `privateCloud`, `name`, `numberOfPublicIPs`, `displayName`, or
 * `resourceGroup` replaces the block. The new block has new addresses.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/enable-public-ip-nsx-edge
 *
 * ### Allocating Public IPs
 * **Example:** Allocate four public IPs
 * ```typescript
 * const cloud = yield* Azure.VMware.PrivateCloud("cloud", {
 *   sku: "av36p",
 *   networkBlock: "10.175.0.0/22",
 *   clusterSize: 3,
 * });
 * const ips = yield* Azure.VMware.WorkloadNetworkPublicIP("edge", {
 *   privateCloud: cloud.privateCloudName,
 *   numberOfPublicIPs: 4,
 * });
 * // ips.publicIPBlock is the allocated CIDR.
 * ```
 *
 * @resource
 */
export const WorkloadNetworkPublicIP = GroupedResource<WorkloadNetworkPublicIP>(
  "Azure.VMware.WorkloadNetworkPublicIP",
);

const createName = (id: string) => createAvsName(id, 64);

const getWorkloadNetworkPublicIP = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  publicIPId: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetWorkloadNetworkPublicIP({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      publicIPId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetWorkloadNetworkPublicIPResponse,
): WorkloadNetworkPublicIP["Attributes"] => ({
  publicIPName: name,
  publicIPResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  publicIPBlock: observed.properties?.publicIPBlock,
  numberOfPublicIPs: observed.properties?.numberOfPublicIPs,
  provisioningState: observed.properties?.provisioningState,
});

export const WorkloadNetworkPublicIPProvider = () =>
  Provider.succeed(WorkloadNetworkPublicIP, {
    stables: ["publicIPName", "publicIPResourceId", "resourceGroup", "privateCloud"],

    // Lives inside a private cloud; nuke removes it with the private cloud.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.publicIPName) ||
        news.numberOfPublicIPs !== output.numberOfPublicIPs ||
        (olds !== undefined && news.displayName !== olds.displayName)
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
      const name = output?.publicIPName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getWorkloadNetworkPublicIP(
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
      const name = news.name ?? output?.publicIPName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        publicIPId: name,
      };
      const get = getWorkloadNetworkPublicIP(subscriptionId, resourceGroup, privateCloud, name);
      const wait = () =>
        waitForProvisioned(
          `AVS NSX public IP block ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          WORKLOAD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.CreateWorkloadNetworkPublicIP({
          ...where,
          properties: {
            displayName: news.displayName,
            numberOfPublicIPs: news.numberOfPublicIPs,
          },
        });
      }
      observed = yield* wait();

      return toAttrs(resourceGroup, privateCloud, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeleteWorkloadNetworkPublicIP({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          publicIPId: output.publicIPName,
        }),
      );
      yield* waitUntilGone(
        `AVS NSX public IP block ${output.publicIPName}`,
        getWorkloadNetworkPublicIP(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.publicIPName,
        ),
        WORKLOAD_BUDGET,
      );
    }),
  });
