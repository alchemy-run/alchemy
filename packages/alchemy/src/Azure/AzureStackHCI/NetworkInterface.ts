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

/** IP configuration of a network interface (subnet reference, private IP). */
export type NetworkInterfaceIpConfiguration = hci.IPConfigurationInput;

export interface NetworkInterfaceProps {
  /** Resource group the network interface is created in. Changing it replaces the network interface. */
  resourceGroup: string;
  /**
   * Name of the network interface. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the network interface.
   */
  name?: string;
  /**
   * Azure region of the network interface; must match the custom location's region.
   * Changing it replaces the network interface.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Arc custom location of the Azure Local cluster that hosts the network interface.
   * Changing it replaces the network interface.
   */
  extendedLocation: HciExtendedLocation;
  /**
   * IP configurations, each referencing a logical network subnet.
   * Changing them replaces the interface.
   */
  ipConfigurations?: NetworkInterfaceIpConfiguration[];
  /** MAC address of the interface. Changing it replaces the interface. */
  macAddress?: string;
  /** DNS settings. Changing them replaces the interface. */
  dnsSettings?: {
    /** DNS server IP addresses. */
    dnsServers?: string[];
  };
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkInterface extends Resource<
  "Azure.AzureStackHCI.NetworkInterface",
  NetworkInterfaceProps,
  {
    /** Name of the network interface. */
    networkInterfaceName: string;
    /** Resource group that holds the network interface. */
    resourceGroup: string;
    /** ARM resource ID of the network interface. */
    networkInterfaceId: string;
    /** Azure region of the network interface. */
    location: string;
    /** ARM ID of the Arc custom location that hosts the network interface. */
    customLocationId: string | undefined;
    /** Provisioning state of the network interface. */
    provisioningState: string | undefined;
    /** MAC address of the interface. */
    macAddress: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A network interface on an Azure Local logical network, attached to Arc
 * VMs. Needs an Arc custom location backed by the Arc Resource Bridge of a
 * deployed Azure Local cluster.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/create-network-interfaces
 *
 * ### Creating a Network Interface
 * **Example:** Interface on a logical network
 * ```typescript
 * const nic = yield* Azure.AzureStackHCI.NetworkInterface("vm-nic", {
 *   resourceGroup: group.resourceGroupName,
 *   extendedLocation: { name: customLocationId },
 *   ipConfigurations: [
 *     { name: "ipconfig", properties: { subnet: { id: lnet.logicalNetworkId } } },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NetworkInterface = Resource<NetworkInterface>(
  "Azure.AzureStackHCI.NetworkInterface",
);

const SPEC_KEYS = ["ipConfigurations", "macAddress", "dnsSettings"] as const;

const getNetworkInterface = (
  subscriptionId: string,
  resourceGroupName: string,
  networkInterfaceName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetNetworkInterface({
      subscriptionId,
      resourceGroupName,
      networkInterfaceName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: hci.GetNetworkInterfaceResponse,
): NetworkInterface["Attributes"] => ({
  networkInterfaceName: name,
  resourceGroup,
  networkInterfaceId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation?.name,
  provisioningState: value.properties?.provisioningState,
  macAddress: value.properties?.macAddress,
  tags: userTags(value.tags),
});

export const NetworkInterfaceProvider = () =>
  Provider.succeed(NetworkInterface, {
    stables: [
      "networkInterfaceName",
      "resourceGroup",
      "networkInterfaceId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        hci
          .ListNetworkInterfaceAll({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListNetworkInterfaceAll", page),
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
          !sameId(news.name, output.networkInterfaceName)) ||
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
        output?.networkInterfaceName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getNetworkInterface(
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
        news.name ?? output?.networkInterfaceName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkInterfaceName: name,
      };
      const get = getNetworkInterface(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `Azure Local network interface ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Everything but tags is immutable (diff replaces), so the
      // PUT only runs when the network interface is missing.
      if (observed === undefined) {
        yield* hci.NetworkInterfacesCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            ipConfigurations: news.ipConfigurations,
            macAddress: news.macAddress,
            dnsSettings: news.dnsSettings,
          },
        });
        observed = yield* settle;
      }

      // Sync tags against the observed network interface.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hci.UpdateNetworkInterface({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteNetworkInterface({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          networkInterfaceName: output.networkInterfaceName,
        }),
      );
      yield* waitUntilGone(
        `Azure Local network interface ${output.networkInterfaceName}`,
        getNetworkInterface(
          subscriptionId,
          output.resourceGroup,
          output.networkInterfaceName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
