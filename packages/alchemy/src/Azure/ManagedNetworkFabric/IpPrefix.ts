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

export type IpPrefixRule = mnf.IpPrefixRule;

export interface IpPrefixProps {
  /**
   * Resource group the IP prefix list is created in. Changing it replaces
   * the list.
   */
  resourceGroup: string;
  /**
   * Name of the IP prefix list. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the list.
   */
  name?: string;
  /**
   * Azure location of the list. Changing it replaces the list.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Prefix rules, evaluated from the lowest `sequenceNumber` until one
   * matches, e.g. `{ action: "Permit", sequenceNumber: 10, networkPrefix: "10.0.0.0/8" }`.
   */
  ipPrefixRules: IpPrefixRule[];
  /** Free-form description of the list. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface IpPrefix extends Resource<
  "Azure.ManagedNetworkFabric.IpPrefix",
  IpPrefixProps,
  {
    /** Name of the IP prefix list. */
    ipPrefixName: string;
    /** ARM resource ID of the list; reference it from route policies. */
    ipPrefixId: string;
    /** Resource group that holds the list. */
    resourceGroup: string;
    /** Location of the list. */
    location: string;
    /** Prefix rules as reported by Azure. */
    ipPrefixRules: IpPrefixRule[];
    /** Description of the list. */
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
 * An Azure Operator Nexus IP prefix list — a reusable, ordered list of
 * permit/deny network prefixes that route policies match on. The list is
 * plain ARM configuration; it is pushed to fabric devices only when a
 * route policy on a Network Fabric references it.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-route-policy
 *
 * ### Creating an IP Prefix List
 * **Example:** Permit the 10.0.0.0/8 range
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const prefixes = yield* Azure.ManagedNetworkFabric.IpPrefix("private", {
 *   resourceGroup: group.resourceGroupName,
 *   ipPrefixRules: [
 *     { action: "Permit", sequenceNumber: 10, networkPrefix: "10.0.0.0/8" },
 *   ],
 * });
 * ```
 *
 * **Example:** Match /24 and longer prefixes
 * ```typescript
 * const prefixes = yield* Azure.ManagedNetworkFabric.IpPrefix("subnets", {
 *   resourceGroup: group.resourceGroupName,
 *   ipPrefixRules: [
 *     {
 *       action: "Permit",
 *       sequenceNumber: 10,
 *       networkPrefix: "10.10.0.0/16",
 *       condition: "GreaterThanOrEqualTo",
 *       subnetMaskLength: "24",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const IpPrefix = Resource<IpPrefix>(
  "Azure.ManagedNetworkFabric.IpPrefix",
);

type Observed = mnf.GetIpPrefixResponse;

const getIpPrefix = (
  subscriptionId: string,
  resourceGroupName: string,
  ipPrefixName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetIpPrefix({ subscriptionId, resourceGroupName, ipPrefixName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): IpPrefix["Attributes"] => ({
  ipPrefixName: name,
  ipPrefixId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  ipPrefixRules: [...(observed.properties?.ipPrefixRules ?? [])],
  annotation: observed.properties?.annotation,
  provisioningState: observed.properties?.provisioningState,
  configurationState: observed.properties?.configurationState,
  administrativeState: observed.properties?.administrativeState,
  tags: userTags(observed.tags),
});

export const IpPrefixProvider = () =>
  Provider.succeed(IpPrefix, {
    stables: ["ipPrefixName", "ipPrefixId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListIpPrefixBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListIpPrefixBySubscription", page),
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
        (news.name !== undefined && !sameArm(news.name, output.ipPrefixName)) ||
        (news.location !== undefined && !sameArm(news.location, output.location))
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
        output?.ipPrefixName ?? olds?.name ?? (yield* createFabricName(id));
      const observed = yield* getIpPrefix(subscriptionId, resourceGroup, name);
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
        news.name ?? output?.ipPrefixName ?? (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        ipPrefixName: name,
      };
      const label = `IP prefix ${name}`;
      const get = getIpPrefix(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateIpPrefix({
          ...where,
          location,
          tags,
          properties: {
            ipPrefixRules: news.ipPrefixRules,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync rules, annotation, and tags against observed state.
      const delta = propertyDelta(observed.properties, {
        ipPrefixRules: news.ipPrefixRules,
        annotation: news.annotation,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateIpPrefix({
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
      yield* ignoreNotFound(
        mnf.DeleteIpPrefix({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          ipPrefixName: output.ipPrefixName,
        }),
      );
      yield* waitUntilGone(
        `IP prefix ${output.ipPrefixName}`,
        getIpPrefix(subscriptionId, output.resourceGroup, output.ipPrefixName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
