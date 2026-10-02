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

export interface IpCommunityProps {
  /**
   * Resource group the IP community list is created in. Changing it replaces the
   * IP community list.
   */
  resourceGroup: string;
  /**
   * Name of the IP community list. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the IP community list.
   */
  name?: string;
  /**
   * Azure location of the IP community list. Changing it replaces the IP community list.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Community rules, evaluated from the lowest `sequenceNumber`, e.g.
   * `{ action: "Permit", sequenceNumber: 10, communityMembers: ["65000:100"] }`.
   */
  ipCommunityRules: mnf.IpCommunityPropertiesInput["ipCommunityRules"];
  /**
   * Free-form description. Azure cannot update it in place, so changing
   * it replaces the resource.
   */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface IpCommunity extends Resource<
  "Azure.ManagedNetworkFabric.IpCommunity",
  IpCommunityProps,
  {
    /** Name of the IP community list. */
    ipCommunityName: string;
    /** ARM resource ID of the IP community list. */
    ipCommunityId: string;
    /** Resource group that holds the IP community list. */
    resourceGroup: string;
    /** Location of the IP community list. */
    location: string;
    /** Description of the IP community list. */
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
 * An Azure Operator Nexus IP community list — BGP standard community
 * values (`AA:NN` or well-known communities) that route policies match on or
 * set. The list is plain ARM configuration until a route policy on a Network
 * Fabric references it.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-route-policy
 *
 * ### Creating an IP Community List
 * **Example:** Match a community value
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const community = yield* Azure.ManagedNetworkFabric.IpCommunity("tenant", {
 *   resourceGroup: group.resourceGroupName,
 *   ipCommunityRules: [
 *     { action: "Permit", sequenceNumber: 10, communityMembers: ["65000:100"] },
 *   ],
 * });
 * ```
 *
 * **Example:** Match a well-known community
 * ```typescript
 * const noExport = yield* Azure.ManagedNetworkFabric.IpCommunity("no-export", {
 *   resourceGroup: group.resourceGroupName,
 *   ipCommunityRules: [
 *     {
 *       action: "Deny",
 *       sequenceNumber: 10,
 *       wellKnownCommunities: ["NoExport"],
 *       communityMembers: ["65000:1"],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const IpCommunity = Resource<IpCommunity>(
  "Azure.ManagedNetworkFabric.IpCommunity",
);

type Observed = mnf.GetIpCommunityResponse;

const getIpCommunity = (
  subscriptionId: string,
  resourceGroupName: string,
  ipCommunityName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetIpCommunity({ subscriptionId, resourceGroupName, ipCommunityName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): IpCommunity["Attributes"] => {
  const p = observed.properties;
  return {
    ipCommunityName: name,
    ipCommunityId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const IpCommunityProvider = () =>
  Provider.succeed(IpCommunity, {
    stables: ["ipCommunityName", "ipCommunityId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListIpCommunityBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListIpCommunityBySubscription", page),
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
          !sameArm(news.name, output.ipCommunityName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined && differs(news.annotation, olds.annotation))
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
        output?.ipCommunityName ?? olds?.name ?? (yield* createFabricName(id));
      const observed = yield* getIpCommunity(
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
        news.name ?? output?.ipCommunityName ?? (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        ipCommunityName: name,
      };
      const label = `IP community list ${name}`;
      const get = getIpCommunity(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateIpCommunity({
          ...where,
          location,
          tags,
          properties: {
            ipCommunityRules: news.ipCommunityRules,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        ipCommunityRules: news.ipCommunityRules,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateIpCommunity({
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
        ipCommunityName: output.ipCommunityName,
      };
      const label = `IP community list ${output.ipCommunityName}`;
      const get = getIpCommunity(
        subscriptionId,
        output.resourceGroup,
        output.ipCommunityName,
      );
      yield* ignoreNotFound(mnf.DeleteIpCommunity(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
