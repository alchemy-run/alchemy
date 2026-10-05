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
  annotationMarker,
  createFabricName,
  differs,
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface ExternalNetworkProps {
  /**
   * Resource group the external network is created in. Changing it replaces the
   * external network.
   */
  resourceGroup: string;
  /**
   * Name of the parent L3 isolation domain (in the same resource group).
   * Changing it replaces the network.
   */
  l3IsolationDomain: string;
  /**
   * Name of the external network. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the external network.
   */
  name?: string;
  /**
   * Peering option (`OptionA` or `OptionB`). Changing it replaces the
   * network.
   */
  peeringOption: mnf.ExternalNetworkPropertiesInput["peeringOption"];
  /** Option A peering: VLAN, peer ASN, primary/secondary prefixes, BFD. */
  optionAProperties?: mnf.ExternalNetworkPropertiesInput["optionAProperties"];
  /** Option B peering: import/export route targets. */
  optionBProperties?: mnf.ExternalNetworkPropertiesInput["optionBProperties"];
  /** Import route policies (IPv4/IPv6 route policy IDs). */
  importRoutePolicy?: mnf.ExternalNetworkPropertiesInput["importRoutePolicy"];
  /** Export route policies (IPv4/IPv6 route policy IDs). */
  exportRoutePolicy?: mnf.ExternalNetworkPropertiesInput["exportRoutePolicy"];
  /** Network-to-network interconnect used for the peering. */
  networkToNetworkInterconnectId?: string;
  /** Static routes and BFD. */
  staticRouteConfiguration?: mnf.ExternalNetworkPropertiesInput["staticRouteConfiguration"];
}

export interface ExternalNetwork extends Resource<
  "Azure.ManagedNetworkFabric.ExternalNetwork",
  ExternalNetworkProps,
  {
    /** Name of the external network. */
    externalNetworkName: string;
    /** ARM resource ID of the external network. */
    externalNetworkId: string;
    /** Resource group that holds the external network. */
    resourceGroup: string;
    /** Name of the parent L3 isolation domain. */
    l3IsolationDomain: string;
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
 * An Azure Operator Nexus external network — the peering from an L3
 * isolation domain to provider edge routers (Option A or Option B). Alchemy
 * marks ownership in `properties.annotation`. Needs an Operator Nexus Network
 * Fabric.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-isolation-domain
 *
 * ### Creating an External Network
 * **Example:** Option B peering
 * ```typescript
 * const external = yield* Azure.ManagedNetworkFabric.ExternalNetwork("pe", {
 *   resourceGroup: group.resourceGroupName,
 *   l3IsolationDomain: l3.l3IsolationDomainName,
 *   peeringOption: "OptionB",
 *   optionBProperties: {
 *     routeTargets: {
 *       importIpv4RouteTargets: ["65046:10039"],
 *       exportIpv4RouteTargets: ["65046:10039"],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ExternalNetwork = Resource<ExternalNetwork>(
  "Azure.ManagedNetworkFabric.ExternalNetwork",
);

type Observed = mnf.GetExternalNetworkResponse;

const getExternalNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  l3IsolationDomainName: string,
  externalNetworkName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetExternalNetwork({
      subscriptionId,
      resourceGroupName,
      l3IsolationDomainName,
      externalNetworkName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  l3IsolationDomain: string,
  name: string,
  observed: Observed,
): ExternalNetwork["Attributes"] => {
  const p = observed.properties;
  return {
    externalNetworkName: name,
    externalNetworkId: observed.id ?? "",
    resourceGroup,
    l3IsolationDomain,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
  };
};

export const ExternalNetworkProvider = () =>
  Provider.succeed(ExternalNetwork, {
    stables: [
      "externalNetworkName",
      "externalNetworkId",
      "resourceGroup",
      "l3IsolationDomain",
    ],

    // Child of L3 isolation domain: deleted together with its parent.
    list: Effect.fn(function* () {
      return [] as ExternalNetwork["Attributes"][];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.l3IsolationDomain, output.l3IsolationDomain) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.externalNetworkName)) ||
        (olds !== undefined && differs(news.peeringOption, olds.peeringOption))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const parent = output?.l3IsolationDomain ?? olds?.l3IsolationDomain;
      if (resourceGroup === undefined || parent === undefined) return undefined;
      const name =
        output?.externalNetworkName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getExternalNetwork(
        subscriptionId,
        resourceGroup,
        parent,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, parent, name, observed);
      return observed.properties?.annotation === (yield* annotationMarker(id))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const parent = news.l3IsolationDomain;
      const name =
        news.name ??
        output?.externalNetworkName ??
        (yield* createFabricName(id));
      const annotation = yield* annotationMarker(id);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        l3IsolationDomainName: parent,
        externalNetworkName: name,
      };
      const label = `external network ${name}`;
      const get = getExternalNetwork(
        subscriptionId,
        resourceGroup,
        parent,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateExternalNetwork({
          ...where,
          properties: {
            peeringOption: news.peeringOption,
            optionAProperties: news.optionAProperties,
            optionBProperties: news.optionBProperties,
            importRoutePolicy: news.importRoutePolicy,
            exportRoutePolicy: news.exportRoutePolicy,
            networkToNetworkInterconnectId: news.networkToNetworkInterconnectId,
            staticRouteConfiguration: news.staticRouteConfiguration,
            annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        optionAProperties: news.optionAProperties,
        optionBProperties: news.optionBProperties,
        importRoutePolicy: news.importRoutePolicy,
        exportRoutePolicy: news.exportRoutePolicy,
        networkToNetworkInterconnectId: news.networkToNetworkInterconnectId,
        staticRouteConfiguration: news.staticRouteConfiguration,
        annotation,
      });
      if (delta !== undefined) {
        yield* mnf.UpdateExternalNetwork({
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
        l3IsolationDomainName: output.l3IsolationDomain,
        externalNetworkName: output.externalNetworkName,
      };
      const label = `external network ${output.externalNetworkName}`;
      const get = getExternalNetwork(
        subscriptionId,
        output.resourceGroup,
        output.l3IsolationDomain,
        output.externalNetworkName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateExternalNetworkAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteExternalNetwork(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ManagedNetworkFabric.L3IsolationDomain",
      ],
    },
  });
