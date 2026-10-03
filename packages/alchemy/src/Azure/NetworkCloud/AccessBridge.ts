import * as nc from "@distilled.cloud/azure/networkcloud";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  customLocation,
  NEXUS_BUDGET,
  NEXUS_NAMESPACE,
  propertyDelta,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";

export interface AccessBridgeProps {
  /**
   * Resource group the access bridge is created in. Changing it replaces the
   * access bridge.
   */
  resourceGroup: string;
  /**
   * Kind of access bridge: `Bastion`, `PrivateVault`, or
   * `StorageDashboard`. The name is also the bridge type.
   * Changing it replaces the access bridge.
   */
  name: "Bastion" | "PrivateVault" | "StorageDashboard";
  /**
   * Azure location of the access bridge; must match the location of the Nexus
   * cluster. Changing it replaces the access bridge.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the access bridge.
   */
  customLocationId: string;
  /**
   * ARM ID of the L3 network the bridge exposes endpoints on. Changing it
   * replaces the access bridge.
   */
  networkId: string;
  /** IPv4 prefix (CIDR) for the bridge endpoints. Changing it replaces the bridge. */
  ipv4ConnectedPrefix?: string;
  /** IPv6 prefix (CIDR) for the bridge endpoints. Changing it replaces the bridge. */
  ipv6ConnectedPrefix?: string;
  /** Security rules that govern traffic through the bridge. */
  securityRules?: nc.AccessBridgeSecurityRule[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AccessBridge extends Resource<
  "Azure.NetworkCloud.AccessBridge",
  AccessBridgeProps,
  {
    /** Name of the access bridge. */
    accessBridgeName: string;
    /** ARM resource ID of the access bridge. */
    accessBridgeId: string;
    /** Resource group that holds the access bridge. */
    resourceGroup: string;
    /** Location of the access bridge. */
    location: string;
    /** Custom location the access bridge is deployed to. */
    customLocationId: string | undefined;
    /** ARM ID of the network the bridge is attached to. */
    networkId: string;
    /** Protocol served by the bridge. */
    protocol: string | undefined;
    /** Detailed status reported by the platform. */
    detailedStatus: string | undefined;
    /** Message describing the detailed status. */
    detailedStatusMessage: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus access bridge — a managed bastion, private vault,
 * or storage dashboard endpoint exposed on a Nexus L3 network. The bridge's
 * name is its type, so one of each kind exists per resource group. Needs a
 * deployed Operator Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/
 *
 * ### Creating an Access Bridge
 * **Example:** Bastion on an L3 network
 * ```typescript
 * const bastion = yield* Azure.NetworkCloud.AccessBridge("bastion", {
 *   resourceGroup: group.resourceGroupName,
 *   name: "Bastion",
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   networkId: l3.l3NetworkId,
 *   securityRules: [
 *     { direction: "Inbound", port: "22", ipv4Addresses: ["10.0.0.0/8"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const AccessBridge = Resource<AccessBridge>(
  "Azure.NetworkCloud.AccessBridge",
);

type Observed = nc.GetAccessBridgeResponse;

const getAccessBridge = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetAccessBridge({
      subscriptionId,
      resourceGroupName,
      accessBridgeName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): AccessBridge["Attributes"] => {
  const p = observed.properties;
  return {
    accessBridgeName: name,
    accessBridgeId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    networkId: p.networkId,
    protocol: p.protocol,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const AccessBridgeProvider = () =>
  Provider.succeed(AccessBridge, {
    stables: [
      "accessBridgeName",
      "accessBridgeId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListAccessBridgeBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAccessBridgeBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.name, output.accessBridgeName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        !sameArm(news.networkId, output.networkId) ||
        (olds !== undefined &&
          (news.ipv4ConnectedPrefix !== olds.ipv4ConnectedPrefix ||
            !sameArm(news.ipv6ConnectedPrefix, olds.ipv6ConnectedPrefix)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.accessBridgeName ?? olds?.name;
      if (name === undefined) return undefined;
      const observed = yield* getAccessBridge(
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
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name = news.name;
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accessBridgeName: name,
      };
      const label = `Nexus access bridge ${name}`;
      const get = getAccessBridge(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.AccessBridgesCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            networkId: news.networkId,
            ipv4ConnectedPrefix: news.ipv4ConnectedPrefix,
            ipv6ConnectedPrefix: news.ipv6ConnectedPrefix,
            securityRules: news.securityRules,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        securityRules: news.securityRules,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* nc.UpdateAccessBridge({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.accessBridgeName;
      yield* ignoreNotFound(
        nc.DeleteAccessBridge({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accessBridgeName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus access bridge ${name}`,
        getAccessBridge(subscriptionId, output.resourceGroup, name),
        NEXUS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.NetworkCloud.L3Network",
      ],
    },
  });
