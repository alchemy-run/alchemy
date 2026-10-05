import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AVS_NAMESPACE,
  WORKLOAD_BUDGET,
  createAvsName,
  isPrivateCloudOwnedByStack,
  parentChanged,
  sameSet,
} from "./common.ts";

export interface WorkloadNetworkDhcpProps {
  /** Resource group of the private cloud. Changing it replaces the DHCP configuration. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the DHCP configuration. */
  privateCloud: string;
  /**
   * NSX ID of the DHCP configuration. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the DHCP configuration.
   */
  name?: string;
  /**
   * `SERVER` runs a DHCP server on the NSX edge; `RELAY` forwards requests
   * to external DHCP servers. Changing it replaces the configuration.
   */
  dhcpType: "SERVER" | "RELAY";
  /** Display name of the configuration. */
  displayName?: string;
  /** `SERVER` only: DHCP server address as a CIDR, e.g. `40.20.0.1/24`. */
  serverAddress?: string;
  /** `SERVER` only: lease time in seconds. */
  leaseTime?: number;
  /** `RELAY` only: addresses of the DHCP servers to relay to. */
  serverAddresses?: string[];
}

export interface WorkloadNetworkDhcp extends Resource<
  "Azure.VMware.WorkloadNetworkDhcp",
  WorkloadNetworkDhcpProps,
  {
    /** NSX ID of the DHCP configuration. */
    dhcpName: string;
    /** ARM resource ID of the DHCP configuration. */
    dhcpResourceId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Name of the private cloud. */
    privateCloud: string;
    /** DHCP type (`SERVER` or `RELAY`). */
    dhcpType: string;
    /** NSX segments using this configuration. */
    segments: string[];
    /** Provisioning state. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A DHCP server or relay on the NSX-T tier-1 gateway of an Azure VMware
 * Solution private cloud. Attach it to segments via their subnet's DHCP
 * ranges.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/configure-dhcp-azure-vmware-solution
 *
 * ### DHCP Server
 * **Example:** NSX DHCP server
 * ```typescript
 * yield* Azure.VMware.WorkloadNetworkDhcp("dhcp", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   dhcpType: "SERVER",
 *   serverAddress: "40.20.0.1/24",
 *   leaseTime: 86400,
 * });
 * ```
 *
 * ### DHCP Relay
 * **Example:** Relay to existing DHCP servers
 * ```typescript
 * yield* Azure.VMware.WorkloadNetworkDhcp("relay", {
 *   resourceGroup: group.resourceGroupName,
 *   privateCloud: cloud.privateCloudName,
 *   dhcpType: "RELAY",
 *   serverAddresses: ["10.0.0.4", "10.0.0.5"],
 * });
 * ```
 *
 * @resource
 */
export const WorkloadNetworkDhcp = Resource<WorkloadNetworkDhcp>(
  "Azure.VMware.WorkloadNetworkDhcp",
);

const createName = (id: string) => createAvsName(id, 64);

const getWorkloadNetworkDhcp = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
  dhcpId: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetWorkloadNetworkDhcp({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
      dhcpId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateCloud: string,
  name: string,
  observed: vmware.GetWorkloadNetworkDhcpResponse,
): WorkloadNetworkDhcp["Attributes"] => ({
  dhcpName: name,
  dhcpResourceId: observed.id ?? "",
  resourceGroup,
  privateCloud,
  dhcpType: observed.properties?.dhcpType ?? "",
  segments: [...(observed.properties?.segments ?? [])],
  provisioningState: observed.properties?.provisioningState,
});

const desired = (news: WorkloadNetworkDhcpProps) => ({
  dhcpType: news.dhcpType,
  displayName: news.displayName,
  serverAddress: news.serverAddress,
  leaseTime: news.leaseTime,
  serverAddresses: news.serverAddresses,
});

export const WorkloadNetworkDhcpProvider = () =>
  Provider.succeed(WorkloadNetworkDhcp, {
    stables: ["dhcpName", "dhcpResourceId", "resourceGroup", "privateCloud"],

    // Lives inside a private cloud; nuke removes it with the private cloud.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.dhcpName) ||
        news.dhcpType !== output.dhcpType
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
      const name = output?.dhcpName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getWorkloadNetworkDhcp(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, privateCloud, name, observed);
      return (yield* isPrivateCloudOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateCloud,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const { resourceGroup, privateCloud } = news;
      const name = news.name ?? output?.dhcpName ?? (yield* createName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: privateCloud,
        dhcpId: name,
      };
      const get = getWorkloadNetworkDhcp(
        subscriptionId,
        resourceGroup,
        privateCloud,
        name,
      );
      const wait = () =>
        waitForProvisioned(
          `AVS NSX DHCP configuration ${name}`,
          get,
          (value) => value.properties?.provisioningState,
          WORKLOAD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vmware.CreateWorkloadNetworkDhcp({
          ...where,
          properties: desired(news),
        });
      }
      observed = yield* wait();

      // Sync mutable fields against the observed NSX object. NSX uses the
      // revision for optimistic concurrency, so send back the observed one.
      const props = observed.properties;
      if (
        (news.displayName !== undefined &&
          props?.displayName !== news.displayName) ||
        (news.serverAddress !== undefined &&
          props?.serverAddress !== news.serverAddress) ||
        (news.leaseTime !== undefined && props?.leaseTime !== news.leaseTime) ||
        (news.serverAddresses !== undefined &&
          !sameSet(props?.serverAddresses, news.serverAddresses))
      ) {
        yield* vmware.UpdateWorkloadNetworkDhcp({
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
        vmware.DeleteWorkloadNetworkDhcp({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloud,
          dhcpId: output.dhcpName,
        }),
      );
      yield* waitUntilGone(
        `AVS NSX DHCP configuration ${output.dhcpName}`,
        getWorkloadNetworkDhcp(
          subscriptionId,
          output.resourceGroup,
          output.privateCloud,
          output.dhcpName,
        ),
        WORKLOAD_BUDGET,
      );
    }),
  });
