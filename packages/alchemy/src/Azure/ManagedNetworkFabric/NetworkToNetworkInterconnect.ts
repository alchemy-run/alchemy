import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
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

export interface NetworkToNetworkInterconnectProps {
  /**
   * Resource group the network-to-network interconnect is created in. Changing it replaces the
   * network-to-network interconnect.
   */
  resourceGroup: string;
  /**
   * Name of the parent Network Fabric (in the same resource group).
   * Changing it replaces the interconnect.
   */
  networkFabric: string;
  /**
   * Name of the network-to-network interconnect. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the network-to-network interconnect.
   */
  name?: string;
  /**
   * Use Option B peering (`True`/`False`). Changing it replaces the
   * interconnect.
   */
  useOptionB: mnf.NetworkToNetworkInterconnectPropertiesInput["useOptionB"];
  /**
   * Interconnect type (`CE` or `NPB`). Changing it replaces the
   * interconnect.
   */
  nniType?: mnf.NetworkToNetworkInterconnectPropertiesInput["nniType"];
  /**
   * Whether this is the management interconnect (`True`/`False`).
   * Changing it replaces the interconnect.
   */
  isManagementType?: mnf.NetworkToNetworkInterconnectPropertiesInput["isManagementType"];
  /**
   * Conditional default route configuration. Changing it replaces the
   * interconnect.
   */
  conditionalDefaultRouteConfiguration?: mnf.NetworkToNetworkInterconnectPropertiesInput["conditionalDefaultRouteConfiguration"];
  /** Layer 2 configuration (MTU, interfaces). */
  layer2Configuration?: mnf.NetworkToNetworkInterconnectPropertiesInput["layer2Configuration"];
  /** Option B layer 3 configuration (peer ASN, VLAN, prefixes). */
  optionBLayer3Configuration?: mnf.NetworkToNetworkInterconnectPropertiesInput["optionBLayer3Configuration"];
  /** Static routes for an `NPB` interconnect. */
  npbStaticRouteConfiguration?: mnf.NetworkToNetworkInterconnectPropertiesInput["npbStaticRouteConfiguration"];
  /** Static routes and BFD. */
  staticRouteConfiguration?: mnf.NetworkToNetworkInterconnectPropertiesInput["staticRouteConfiguration"];
  /** Import route policies (IPv4/IPv6 route policy IDs). */
  importRoutePolicy?: mnf.NetworkToNetworkInterconnectPropertiesInput["importRoutePolicy"];
  /** Export route policies (IPv4/IPv6 route policy IDs). */
  exportRoutePolicy?: mnf.NetworkToNetworkInterconnectPropertiesInput["exportRoutePolicy"];
  /** ARM ID of the ingress access control list. */
  ingressAclId?: string;
  /** ARM ID of the egress access control list. */
  egressAclId?: string;
  /** Micro-BFD state (`Enabled`/`Disabled`). */
  microBfdState?: mnf.NetworkToNetworkInterconnectPropertiesInput["microBfdState"];
}

export interface NetworkToNetworkInterconnect extends Resource<
  "Azure.ManagedNetworkFabric.NetworkToNetworkInterconnect",
  NetworkToNetworkInterconnectProps,
  {
    /** Name of the network-to-network interconnect. */
    networkToNetworkInterconnectName: string;
    /** ARM resource ID of the network-to-network interconnect. */
    networkToNetworkInterconnectId: string;
    /** Resource group that holds the network-to-network interconnect. */
    resourceGroup: string;
    /** Name of the parent Network Fabric. */
    networkFabric: string;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** Administrative state, e.g. `Enabled` or `Disabled`. */
    administrativeState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus network-to-network interconnect — the uplink from
 * a Network Fabric's customer edge (or packet broker) devices to the
 * operator's provider edge network. The resource carries no tags or
 * annotation, so ownership comes from Alchemy state. Needs an Operator Nexus
 * Network Fabric.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-network-fabric
 *
 * ### Creating an Interconnect
 * **Example:** Option B interconnect
 * ```typescript
 * const nni = yield* Azure.ManagedNetworkFabric.NetworkToNetworkInterconnect("nni", {
 *   resourceGroup: group.resourceGroupName,
 *   networkFabric: fabric.networkFabricName,
 *   nniType: "CE",
 *   isManagementType: "True",
 *   useOptionB: "True",
 *   optionBLayer3Configuration: {
 *     primaryIpv4Prefix: "10.0.0.12/30",
 *     secondaryIpv4Prefix: "40.0.0.14/30",
 *     peerASN: 61234,
 *     vlanId: 1234,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const NetworkToNetworkInterconnect =
  Resource<NetworkToNetworkInterconnect>(
    "Azure.ManagedNetworkFabric.NetworkToNetworkInterconnect",
  );

type Observed = mnf.GetNetworkToNetworkInterconnectResponse;

const getNetworkToNetworkInterconnect = (
  subscriptionId: string,
  resourceGroupName: string,
  networkFabricName: string,
  networkToNetworkInterconnectName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetNetworkToNetworkInterconnect({
      subscriptionId,
      resourceGroupName,
      networkFabricName,
      networkToNetworkInterconnectName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  networkFabric: string,
  name: string,
  observed: Observed,
): NetworkToNetworkInterconnect["Attributes"] => {
  const p = observed.properties;
  return {
    networkToNetworkInterconnectName: name,
    networkToNetworkInterconnectId: observed.id ?? "",
    resourceGroup,
    networkFabric,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
  };
};

export const NetworkToNetworkInterconnectProvider = () =>
  Provider.succeed(NetworkToNetworkInterconnect, {
    stables: [
      "networkToNetworkInterconnectName",
      "networkToNetworkInterconnectId",
      "resourceGroup",
      "networkFabric",
    ],

    // Child of network fabric: deleted together with its parent.
    list: Effect.fn(function* () {
      return [] as NetworkToNetworkInterconnect["Attributes"][];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.networkFabric, output.networkFabric) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.networkToNetworkInterconnectName)) ||
        (olds !== undefined &&
          (differs(news.useOptionB, olds.useOptionB) ||
            differs(news.nniType, olds.nniType) ||
            differs(news.isManagementType, olds.isManagementType) ||
            differs(
              news.conditionalDefaultRouteConfiguration,
              olds.conditionalDefaultRouteConfiguration,
            )))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const parent = output?.networkFabric ?? olds?.networkFabric;
      if (resourceGroup === undefined || parent === undefined) return undefined;
      const name =
        output?.networkToNetworkInterconnectName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getNetworkToNetworkInterconnect(
        subscriptionId,
        resourceGroup,
        parent,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, parent, name, observed);
      // No tags or annotation on this child: ownership is our persisted state.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const parent = news.networkFabric;
      const name =
        news.name ??
        output?.networkToNetworkInterconnectName ??
        (yield* createFabricName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkFabricName: parent,
        networkToNetworkInterconnectName: name,
      };
      const label = `network-to-network interconnect ${name}`;
      const get = getNetworkToNetworkInterconnect(
        subscriptionId,
        resourceGroup,
        parent,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateNetworkToNetworkInterconnect({
          ...where,
          properties: {
            useOptionB: news.useOptionB,
            nniType: news.nniType,
            isManagementType: news.isManagementType,
            conditionalDefaultRouteConfiguration:
              news.conditionalDefaultRouteConfiguration,
            layer2Configuration: news.layer2Configuration,
            optionBLayer3Configuration: news.optionBLayer3Configuration,
            npbStaticRouteConfiguration: news.npbStaticRouteConfiguration,
            staticRouteConfiguration: news.staticRouteConfiguration,
            importRoutePolicy: news.importRoutePolicy,
            exportRoutePolicy: news.exportRoutePolicy,
            ingressAclId: news.ingressAclId,
            egressAclId: news.egressAclId,
            microBfdState: news.microBfdState,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        layer2Configuration: news.layer2Configuration,
        optionBLayer3Configuration: news.optionBLayer3Configuration,
        npbStaticRouteConfiguration: news.npbStaticRouteConfiguration,
        staticRouteConfiguration: news.staticRouteConfiguration,
        importRoutePolicy: news.importRoutePolicy,
        exportRoutePolicy: news.exportRoutePolicy,
        ingressAclId: news.ingressAclId,
        egressAclId: news.egressAclId,
        microBfdState: news.microBfdState,
      });
      if (delta !== undefined) {
        yield* mnf.UpdateNetworkToNetworkInterconnect({
          ...where,
          properties: delta,
        });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, parent, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        networkFabricName: output.networkFabric,
        networkToNetworkInterconnectName:
          output.networkToNetworkInterconnectName,
      };
      const label = `network-to-network interconnect ${output.networkToNetworkInterconnectName}`;
      const get = getNetworkToNetworkInterconnect(
        subscriptionId,
        output.resourceGroup,
        output.networkFabric,
        output.networkToNetworkInterconnectName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateNetworkToNetworkInterconnectAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteNetworkToNetworkInterconnect(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ManagedNetworkFabric.NetworkFabric",
      ],
    },
  });
