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

export interface L3IsolationDomainProps {
  /**
   * Resource group the L3 isolation domain is created in. Changing it replaces the
   * L3 isolation domain.
   */
  resourceGroup: string;
  /**
   * Name of the L3 isolation domain. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the L3 isolation domain.
   */
  name?: string;
  /**
   * Azure location of the L3 isolation domain. Changing it replaces the L3 isolation domain.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** ARM ID of the Network Fabric. Changing it replaces the domain. */
  networkFabricId: string;
  /**
   * Unique route distinguisher configuration. Changing it replaces the
   * domain.
   */
  uniqueRdConfiguration?: mnf.L3IsolationDomainPropertiesInput["uniqueRdConfiguration"];
  /** Advertise connected subnets (`True`/`False`). */
  redistributeConnectedSubnets?: mnf.L3IsolationDomainPropertiesInput["redistributeConnectedSubnets"];
  /** Advertise static routes (`True`/`False`). */
  redistributeStaticRoutes?: mnf.L3IsolationDomainPropertiesInput["redistributeStaticRoutes"];
  /** IPv4/IPv6 aggregate routes. */
  aggregateRouteConfiguration?: mnf.L3IsolationDomainPropertiesInput["aggregateRouteConfiguration"];
  /** Route policy applied to connected subnets. */
  connectedSubnetRoutePolicy?: mnf.L3IsolationDomainPropertiesInput["connectedSubnetRoutePolicy"];
  /** Route policy applied to static routes. */
  staticRouteRoutePolicy?: mnf.L3IsolationDomainPropertiesInput["staticRouteRoutePolicy"];
  /** IPv4 route prefix limit. */
  v4routePrefixLimit?: mnf.L3IsolationDomainPropertiesInput["v4routePrefixLimit"];
  /** IPv6 route prefix limit. */
  v6routePrefixLimit?: mnf.L3IsolationDomainPropertiesInput["v6routePrefixLimit"];
  /** BMP export policy configuration. */
  exportPolicyConfiguration?: mnf.L3IsolationDomainPropertiesInput["exportPolicyConfiguration"];
  /** Free-form description. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface L3IsolationDomain extends Resource<
  "Azure.ManagedNetworkFabric.L3IsolationDomain",
  L3IsolationDomainProps,
  {
    /** Name of the L3 isolation domain. */
    l3IsolationDomainName: string;
    /** ARM resource ID of the L3 isolation domain. */
    l3IsolationDomainId: string;
    /** Resource group that holds the L3 isolation domain. */
    resourceGroup: string;
    /** Location of the L3 isolation domain. */
    location: string;
    /** Description of the L3 isolation domain. */
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
 * An Azure Operator Nexus L3 isolation domain — a routed VRF on a Network
 * Fabric that hosts internal networks (workload subnets) and external networks
 * (peering to provider edge routers). Needs an Operator Nexus Network Fabric.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-isolation-domain
 *
 * ### Creating an L3 Isolation Domain
 * **Example:** Domain that advertises connected subnets
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * // The Network Fabric is provisioned on Operator Nexus racks.
 * const fabricId =
 *   "/subscriptions/.../resourceGroups/nexus/providers/Microsoft.ManagedNetworkFabric/networkFabrics/fab1";
 * const l3 = yield* Azure.ManagedNetworkFabric.L3IsolationDomain("tenant", {
 *   resourceGroup: group.resourceGroupName,
 *   networkFabricId: fabricId,
 *   redistributeConnectedSubnets: "True",
 *   redistributeStaticRoutes: "False",
 * });
 * ```
 *
 * @resource
 */
export const L3IsolationDomain = Resource<L3IsolationDomain>(
  "Azure.ManagedNetworkFabric.L3IsolationDomain",
);

type Observed = mnf.GetL3IsolationDomainResponse;

const getL3IsolationDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  l3IsolationDomainName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetL3IsolationDomain({
      subscriptionId,
      resourceGroupName,
      l3IsolationDomainName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): L3IsolationDomain["Attributes"] => {
  const p = observed.properties;
  return {
    l3IsolationDomainName: name,
    l3IsolationDomainId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const L3IsolationDomainProvider = () =>
  Provider.succeed(L3IsolationDomain, {
    stables: [
      "l3IsolationDomainName",
      "l3IsolationDomainId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListL3IsolationDomainBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListL3IsolationDomainBySubscription", page),
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
          !sameArm(news.name, output.l3IsolationDomainName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (!sameArm(news.networkFabricId, olds.networkFabricId) ||
            differs(news.uniqueRdConfiguration, olds.uniqueRdConfiguration)))
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
        output?.l3IsolationDomainName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getL3IsolationDomain(
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
        output?.l3IsolationDomainName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        l3IsolationDomainName: name,
      };
      const label = `L3 isolation domain ${name}`;
      const get = getL3IsolationDomain(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateL3IsolationDomain({
          ...where,
          location,
          tags,
          properties: {
            networkFabricId: news.networkFabricId,
            uniqueRdConfiguration: news.uniqueRdConfiguration,
            redistributeConnectedSubnets: news.redistributeConnectedSubnets,
            redistributeStaticRoutes: news.redistributeStaticRoutes,
            aggregateRouteConfiguration: news.aggregateRouteConfiguration,
            connectedSubnetRoutePolicy: news.connectedSubnetRoutePolicy,
            staticRouteRoutePolicy: news.staticRouteRoutePolicy,
            v4routePrefixLimit: news.v4routePrefixLimit,
            v6routePrefixLimit: news.v6routePrefixLimit,
            exportPolicyConfiguration: news.exportPolicyConfiguration,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        redistributeConnectedSubnets: news.redistributeConnectedSubnets,
        redistributeStaticRoutes: news.redistributeStaticRoutes,
        aggregateRouteConfiguration: news.aggregateRouteConfiguration,
        connectedSubnetRoutePolicy: news.connectedSubnetRoutePolicy,
        staticRouteRoutePolicy: news.staticRouteRoutePolicy,
        v4routePrefixLimit: news.v4routePrefixLimit,
        v6routePrefixLimit: news.v6routePrefixLimit,
        exportPolicyConfiguration: news.exportPolicyConfiguration,
        annotation: news.annotation,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateL3IsolationDomain({
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
        l3IsolationDomainName: output.l3IsolationDomainName,
      };
      const label = `L3 isolation domain ${output.l3IsolationDomainName}`;
      const get = getL3IsolationDomain(
        subscriptionId,
        output.resourceGroup,
        output.l3IsolationDomainName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateL3IsolationDomainAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteL3IsolationDomain(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
