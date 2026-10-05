import * as hci from "@distilled.cloud/azure/azurestackhci";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  HCI_NAMESPACE,
  type HciExtendedLocation,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

/** A subnet of a logical network (address prefix, IP pools, VLAN, routes). */
export type LogicalNetworkSubnet = hci.SubnetInput;

export interface LogicalNetworkProps {
  /** Resource group the logical network is created in. Changing it replaces the logical network. */
  resourceGroup: string;
  /**
   * Name of the logical network. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the logical network.
   */
  name?: string;
  /**
   * Azure region of the logical network; must match the custom location's region.
   * Changing it replaces the logical network.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Arc custom location of the Azure Local cluster that hosts the logical network.
   * Changing it replaces the logical network.
   */
  extendedLocation: HciExtendedLocation;
  /**
   * Name of the Hyper-V virtual switch the network is attached to.
   * Changing it replaces the network.
   */
  vmSwitchName?: string;
  /** Subnets of the network. Changing them replaces the network. */
  subnets?: LogicalNetworkSubnet[];
  /** DHCP options. Changing them replaces the network. */
  dhcpOptions?: {
    /** DNS server IP addresses. */
    dnsServers?: string[];
  };
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface LogicalNetwork extends Resource<
  "Azure.AzureStackHCI.LogicalNetwork",
  LogicalNetworkProps,
  {
    /** Name of the logical network. */
    logicalNetworkName: string;
    /** Resource group that holds the logical network. */
    resourceGroup: string;
    /** ARM resource ID of the logical network. */
    logicalNetworkId: string;
    /** Azure region of the logical network. */
    location: string;
    /** ARM ID of the Arc custom location that hosts the logical network. */
    customLocationId: string | undefined;
    /** Provisioning state of the logical network. */
    provisioningState: string | undefined;
    /** Hyper-V virtual switch the network is attached to. */
    vmSwitchName: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A logical network on an Azure Local cluster that Arc VMs attach their
 * network interfaces to, mapped onto a Hyper-V virtual switch (optionally
 * with static IP pools and a VLAN). Needs an Arc custom location backed by
 * the Arc Resource Bridge of a deployed Azure Local cluster.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/create-logical-networks
 *
 * ### Creating a Logical Network
 * **Example:** DHCP network on a virtual switch
 * ```typescript
 * const lnet = yield* Azure.AzureStackHCI.LogicalNetwork("lan", {
 *   resourceGroup: group.resourceGroupName,
 *   extendedLocation: { name: customLocationId },
 *   vmSwitchName: "ConvergedSwitch(management_compute_storage)",
 *   subnets: [{ name: "lan", properties: { ipAllocationMethod: "Dynamic" } }],
 * });
 * ```
 *
 * @resource
 */
export const LogicalNetwork = Resource<LogicalNetwork>(
  "Azure.AzureStackHCI.LogicalNetwork",
);

const SPEC_KEYS = ["vmSwitchName", "subnets", "dhcpOptions"] as const;

const getLogicalNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  logicalNetworkName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetLogicalNetwork({
      subscriptionId,
      resourceGroupName,
      logicalNetworkName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: hci.GetLogicalNetworkResponse,
): LogicalNetwork["Attributes"] => ({
  logicalNetworkName: name,
  resourceGroup,
  logicalNetworkId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation?.name,
  provisioningState: value.properties?.provisioningState,
  vmSwitchName: value.properties?.vmSwitchName,
  tags: userTags(value.tags),
});

export const LogicalNetworkProvider = () =>
  Provider.succeed(LogicalNetwork, {
    stables: [
      "logicalNetworkName",
      "resourceGroup",
      "logicalNetworkId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        hci
          .ListLogicalNetworkAll({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListLogicalNetworkAll", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((value) => {
        const group = resourceGroupOf(value.id);
        return hasAnyAlchemyTag(value.tags) &&
          group !== undefined &&
          value.name !== undefined
          ? [toAttrs(group, value.name, value)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.logicalNetworkName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (olds !== undefined &&
          SPEC_KEYS.some((key) => !sameValue(news[key], olds[key])))
      ) {
        // An explicit name is reused by the replacement, so the old one
        // must go first; generated names differ per instance.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.logicalNetworkName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getLogicalNetwork(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.logicalNetworkName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        logicalNetworkName: name,
      };
      const get = getLogicalNetwork(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `Azure Local logical network ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Everything but tags is immutable (diff replaces), so the
      // PUT only runs when the logical network is missing.
      if (observed === undefined) {
        yield* hci.LogicalNetworksCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            vmSwitchName: news.vmSwitchName,
            subnets: news.subnets,
            dhcpOptions: news.dhcpOptions,
          },
        });
        observed = yield* settle;
      }

      // Sync tags against the observed logical network.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hci.UpdateLogicalNetwork({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteLogicalNetwork({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          logicalNetworkName: output.logicalNetworkName,
        }),
      );
      yield* waitUntilGone(
        `Azure Local logical network ${output.logicalNetworkName}`,
        getLogicalNetwork(
          subscriptionId,
          output.resourceGroup,
          output.logicalNetworkName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
