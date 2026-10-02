import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
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
  createFabricName,
  differs,
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface L2IsolationDomainProps {
  /**
   * Resource group the L2 isolation domain is created in. Changing it replaces the
   * L2 isolation domain.
   */
  resourceGroup: string;
  /**
   * Name of the L2 isolation domain. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the L2 isolation domain.
   */
  name?: string;
  /**
   * Azure location of the L2 isolation domain. Changing it replaces the L2 isolation domain.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** ARM ID of the Network Fabric. Changing it replaces the domain. */
  networkFabricId: string;
  /** VLAN ID of the domain (501-4095). Changing it replaces the domain. */
  vlanId: number;
  /**
   * Maximum transmission unit (64-9200).
   * @default 1500
   */
  mtu?: number;
  /**
   * Extend the VLAN over network-to-network interconnects (`Enabled`/`Disabled`).
   */
  extendedVlan?: mnf.L2IsolationDomainPropertiesInput["extendedVlan"];
  /** Network-to-network interconnect the VLAN is extended over. */
  networkToNetworkInterconnectId?: string;
  /** Free-form description. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface L2IsolationDomain extends Resource<
  "Azure.ManagedNetworkFabric.L2IsolationDomain",
  L2IsolationDomainProps,
  {
    /** Name of the L2 isolation domain. */
    l2IsolationDomainName: string;
    /** ARM resource ID of the L2 isolation domain. */
    l2IsolationDomainId: string;
    /** Resource group that holds the L2 isolation domain. */
    resourceGroup: string;
    /** Location of the L2 isolation domain. */
    location: string;
    /** Description of the L2 isolation domain. */
    annotation: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** Administrative state, e.g. `Enabled` or `Disabled`. */
    administrativeState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus L2 isolation domain — a layer-2 VLAN that connects
 * workloads within and across racks of a Network Fabric. Fabric devices are
 * configured only once the domain is administratively enabled. Needs an
 * Operator Nexus Network Fabric.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-isolation-domain
 *
 * ### Creating an L2 Isolation Domain
 * **Example:** VLAN 750 on a fabric
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * // The Network Fabric is provisioned on Operator Nexus racks.
 * const fabricId =
 *   "/subscriptions/.../resourceGroups/nexus/providers/Microsoft.ManagedNetworkFabric/networkFabrics/fab1";
 * const l2 = yield* Azure.ManagedNetworkFabric.L2IsolationDomain("vlan750", {
 *   resourceGroup: group.resourceGroupName,
 *   networkFabricId: fabricId,
 *   vlanId: 750,
 *   mtu: 9000,
 * });
 * ```
 *
 * @resource
 */
export const L2IsolationDomain = Resource<L2IsolationDomain>(
  "Azure.ManagedNetworkFabric.L2IsolationDomain",
);

type Observed = mnf.GetL2IsolationDomainResponse;

const getL2IsolationDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  l2IsolationDomainName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetL2IsolationDomain({
      subscriptionId,
      resourceGroupName,
      l2IsolationDomainName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): L2IsolationDomain["Attributes"] => {
  const p = observed.properties;
  return {
    l2IsolationDomainName: name,
    l2IsolationDomainId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const L2IsolationDomainProvider = () =>
  Provider.succeed(L2IsolationDomain, {
    stables: [
      "l2IsolationDomainName",
      "l2IsolationDomainId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListL2IsolationDomainBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListL2IsolationDomainBySubscription", page),
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
        (news.name !== undefined &&
          !sameArm(news.name, output.l2IsolationDomainName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (!sameArm(news.networkFabricId, olds.networkFabricId) ||
            differs(news.vlanId, olds.vlanId)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.l2IsolationDomainName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getL2IsolationDomain(
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
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.l2IsolationDomainName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        l2IsolationDomainName: name,
      };
      const label = `L2 isolation domain ${name}`;
      const get = getL2IsolationDomain(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateL2IsolationDomain({
          ...where,
          location,
          tags,
          properties: {
            networkFabricId: news.networkFabricId,
            vlanId: news.vlanId,
            mtu: news.mtu,
            extendedVlan: news.extendedVlan,
            networkToNetworkInterconnectId: news.networkToNetworkInterconnectId,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        mtu: news.mtu,
        extendedVlan: news.extendedVlan,
        networkToNetworkInterconnectId: news.networkToNetworkInterconnectId,
        annotation: news.annotation,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateL2IsolationDomain({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        l2IsolationDomainName: output.l2IsolationDomainName,
      };
      const label = `L2 isolation domain ${output.l2IsolationDomainName}`;
      const get = getL2IsolationDomain(
        subscriptionId,
        output.resourceGroup,
        output.l2IsolationDomainName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateL2IsolationDomainAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteL2IsolationDomain(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
