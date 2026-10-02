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
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface IpExtendedCommunityProps {
  /**
   * Resource group the IP extended community list is created in. Changing it replaces the
   * IP extended community list.
   */
  resourceGroup: string;
  /**
   * Name of the IP extended community list. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the IP extended community list.
   */
  name?: string;
  /**
   * Azure location of the IP extended community list. Changing it replaces the IP extended community list.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Extended community rules, evaluated from the lowest `sequenceNumber`,
   * e.g. `{ action: "Permit", sequenceNumber: 10, routeTargets: ["65000:100"] }`.
   */
  ipExtendedCommunityRules: mnf.IpExtendedCommunityPropertiesInput["ipExtendedCommunityRules"];
  /** Free-form description. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface IpExtendedCommunity extends Resource<
  "Azure.ManagedNetworkFabric.IpExtendedCommunity",
  IpExtendedCommunityProps,
  {
    /** Name of the IP extended community list. */
    ipExtendedCommunityName: string;
    /** ARM resource ID of the IP extended community list. */
    ipExtendedCommunityId: string;
    /** Resource group that holds the IP extended community list. */
    resourceGroup: string;
    /** Location of the IP extended community list. */
    location: string;
    /** Description of the IP extended community list. */
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
 * An Azure Operator Nexus IP extended community list — BGP route-target
 * extended communities that route policies match on or set. The list is plain
 * ARM configuration until a route policy on a Network Fabric references it.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-route-policy
 *
 * ### Creating an Extended Community List
 * **Example:** Match a route target
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const targets = yield* Azure.ManagedNetworkFabric.IpExtendedCommunity("rt", {
 *   resourceGroup: group.resourceGroupName,
 *   ipExtendedCommunityRules: [
 *     { action: "Permit", sequenceNumber: 10, routeTargets: ["65000:100"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const IpExtendedCommunity = Resource<IpExtendedCommunity>(
  "Azure.ManagedNetworkFabric.IpExtendedCommunity",
);

type Observed = mnf.GetIpExtendedCommunityResponse;

const getIpExtendedCommunity = (
  subscriptionId: string,
  resourceGroupName: string,
  ipExtendedCommunityName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetIpExtendedCommunity({
      subscriptionId,
      resourceGroupName,
      ipExtendedCommunityName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): IpExtendedCommunity["Attributes"] => {
  const p = observed.properties;
  return {
    ipExtendedCommunityName: name,
    ipExtendedCommunityId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const IpExtendedCommunityProvider = () =>
  Provider.succeed(IpExtendedCommunity, {
    stables: [
      "ipExtendedCommunityName",
      "ipExtendedCommunityId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListIpExtendedCommunityBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListIpExtendedCommunityBySubscription", page),
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
          !sameArm(news.name, output.ipExtendedCommunityName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
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
        output?.ipExtendedCommunityName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getIpExtendedCommunity(
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
        output?.ipExtendedCommunityName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        ipExtendedCommunityName: name,
      };
      const label = `IP extended community list ${name}`;
      const get = getIpExtendedCommunity(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateIpExtendedCommunity({
          ...where,
          location,
          tags,
          properties: {
            ipExtendedCommunityRules: news.ipExtendedCommunityRules,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        ipExtendedCommunityRules: news.ipExtendedCommunityRules,
        annotation: news.annotation,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateIpExtendedCommunity({
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
        ipExtendedCommunityName: output.ipExtendedCommunityName,
      };
      const label = `IP extended community list ${output.ipExtendedCommunityName}`;
      const get = getIpExtendedCommunity(
        subscriptionId,
        output.resourceGroup,
        output.ipExtendedCommunityName,
      );
      yield* ignoreNotFound(mnf.DeleteIpExtendedCommunity(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
