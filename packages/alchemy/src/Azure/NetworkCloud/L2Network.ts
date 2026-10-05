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
  createNexusName,
  customLocation,
  NEXUS_BUDGET,
  NEXUS_NAMESPACE,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";

export interface L2NetworkProps {
  /**
   * Resource group the L2 network is created in. Changing it replaces the
   * L2 network.
   */
  resourceGroup: string;
  /**
   * Name of the L2 network. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the L2 network.
   */
  name?: string;
  /**
   * Azure location of the L2 network; must match the location of the Nexus
   * cluster. Changing it replaces the L2 network.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the L2 network.
   */
  customLocationId: string;
  /**
   * ARM ID of the Network Fabric L2 isolation domain the network maps to.
   * Changing it replaces the L2 network.
   */
  l2IsolationDomainId: string;
  /**
   * Interface name of the network on attached virtual machines. Changing it
   * replaces the L2 network.
   */
  interfaceName?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface L2Network extends Resource<
  "Azure.NetworkCloud.L2Network",
  L2NetworkProps,
  {
    /** Name of the L2 network. */
    l2NetworkName: string;
    /** ARM resource ID of the L2 network. */
    l2NetworkId: string;
    /** Resource group that holds the L2 network. */
    resourceGroup: string;
    /** Location of the L2 network. */
    location: string;
    /** Custom location the L2 network is deployed to. */
    customLocationId: string | undefined;
    /** ARM ID of the L2 isolation domain. */
    l2IsolationDomainId: string;
    /** Interface name on attached virtual machines. */
    interfaceName: string | undefined;
    /** ARM ID of the Nexus cluster the network is associated with. */
    clusterId: string | undefined;
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
 * An Azure Operator Nexus L2 network — a layer-2 workload network backed by
 * a Network Fabric L2 isolation domain, attached to Nexus virtual machines
 * and Kubernetes clusters. Needs a deployed Operator Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/quickstarts-tenant-workload-prerequisites
 *
 * ### Creating an L2 Network
 * **Example:** L2 network on an isolation domain
 * ```typescript
 * const net = yield* Azure.NetworkCloud.L2Network("l2", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   l2IsolationDomainId: l2Domain.l2IsolationDomainId,
 * });
 * ```
 *
 * @resource
 */
export const L2Network = Resource<L2Network>("Azure.NetworkCloud.L2Network");

type Observed = nc.GetL2NetworkResponse;

const getL2Network = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetL2Network({
      subscriptionId,
      resourceGroupName,
      l2NetworkName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): L2Network["Attributes"] => {
  const p = observed.properties;
  return {
    l2NetworkName: name,
    l2NetworkId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    l2IsolationDomainId: p.l2IsolationDomainId,
    interfaceName: p.interfaceName,
    clusterId: p.clusterId,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const L2NetworkProvider = () =>
  Provider.succeed(L2Network, {
    stables: [
      "l2NetworkName",
      "l2NetworkId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListL2NetworkBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListL2NetworkBySubscription", page),
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

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.l2NetworkName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        !sameArm(news.l2IsolationDomainId, output.l2IsolationDomainId) ||
        (news.interfaceName !== undefined &&
          news.interfaceName !== output.interfaceName)
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
        output?.l2NetworkName ?? olds?.name ?? (yield* createNexusName(id, 63));
      const observed = yield* getL2Network(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.l2NetworkName ?? (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        l2NetworkName: name,
      };
      const label = `Nexus L2 network ${name}`;
      const get = getL2Network(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.L2NetworksCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            l2IsolationDomainId: news.l2IsolationDomainId,
            interfaceName: news.interfaceName,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (tagsChanged) {
        yield* nc.UpdateL2Network({
          ...where,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.l2NetworkName;
      yield* ignoreNotFound(
        nc.DeleteL2Network({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          l2NetworkName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus L2 network ${name}`,
        getL2Network(subscriptionId, output.resourceGroup, name),
        NEXUS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
