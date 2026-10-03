import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createHybridNetworkName,
  FAST_BUDGET,
  NAMESPACE,
  sameArm,
  retryInProgress,
} from "./Common.ts";

export interface NetworkFunctionDefinitionGroupProps {
  /** Resource group of the publisher. Changing it replaces the group. */
  resourceGroup: string;
  /** Name of the publisher that owns the group. Changing it replaces the group. */
  publisher: string;
  /**
   * Group name: 1-64 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the group.
   */
  name?: string;
  /**
   * Azure location; must match the publisher's location. Changing it
   * replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the network function definition group. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkFunctionDefinitionGroup extends Resource<
  "Azure.HybridNetwork.NetworkFunctionDefinitionGroup",
  NetworkFunctionDefinitionGroupProps,
  {
    /** Name of the group. */
    networkFunctionDefinitionGroupName: string;
    /** ARM resource ID of the group. */
    networkFunctionDefinitionGroupId: string;
    /** Name of the publisher that owns the group. */
    publisher: string;
    /** Resource group of the publisher. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** Description of the group. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager network function definition group — a
 * publisher-scoped container for the versions
 * (`NetworkFunctionDefinitionVersion`) of one network function.
 *
 * Groups are free metadata resources.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/network-function-definition-version-overview
 *
 * ### Creating a Group
 * **Example:** Network function definition group
 * ```typescript
 * const nfdg = yield* Azure.HybridNetwork.NetworkFunctionDefinitionGroup(
 *   "firewall",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     publisher: publisher.publisherName,
 *     description: "Virtual firewall network function",
 *   },
 * );
 * ```
 *
 * @resource
 */
export const NetworkFunctionDefinitionGroup =
  Resource<NetworkFunctionDefinitionGroup>(
    "Azure.HybridNetwork.NetworkFunctionDefinitionGroup",
  );

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  publisherName: string,
  networkFunctionDefinitionGroupName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetNetworkFunctionDefinitionGroup({
      subscriptionId,
      resourceGroupName,
      publisherName,
      networkFunctionDefinitionGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  publisher: string,
  name: string,
  group:
    | hybridnetwork.GetNetworkFunctionDefinitionGroupResponse
    | hybridnetwork.NetworkFunctionDefinitionGroup,
): NetworkFunctionDefinitionGroup["Attributes"] => ({
  networkFunctionDefinitionGroupName: name,
  networkFunctionDefinitionGroupId: group.id ?? "",
  publisher,
  resourceGroup,
  location: group.location,
  description: group.properties?.description,
  tags: userTags(group.tags),
});

export const NetworkFunctionDefinitionGroupProvider = () =>
  Provider.succeed(NetworkFunctionDefinitionGroup, {
    stables: [
      "networkFunctionDefinitionGroupName",
      "networkFunctionDefinitionGroupId",
      "publisher",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const publishers = yield* hybridnetwork
        .ListPublisherBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPublisherBySubscription", page),
          ),
        );
      const found: NetworkFunctionDefinitionGroup["Attributes"][] = [];
      for (const publisher of publishers.value ?? []) {
        const group = resourceGroupOf(publisher.id);
        if (group === undefined || publisher.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          hybridnetwork.ListNetworkFunctionDefinitionGroupByPublisher({
            subscriptionId,
            resourceGroupName: group,
            publisherName: publisher.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage(
            "ListNetworkFunctionDefinitionGroupByPublisher",
            page,
          );
        }
        for (const item of page?.value ?? []) {
          if (hasAnyAlchemyTag(item.tags) && item.name !== undefined) {
            found.push(toAttrs(group, publisher.name, item.name, item));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.publisher, output.publisher) ||
        (news.name !== undefined &&
          news.name !== output.networkFunctionDefinitionGroupName) ||
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
      const publisher = output?.publisher ?? olds?.publisher;
      if (resourceGroup === undefined || publisher === undefined) {
        return undefined;
      }
      const name =
        output?.networkFunctionDefinitionGroupName ??
        olds?.name ??
        (yield* createHybridNetworkName(id));
      const observed = yield* getGroup(
        subscriptionId,
        resourceGroup,
        publisher,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, publisher, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, publisher } = news;
      const name =
        news.name ??
        output?.networkFunctionDefinitionGroupName ??
        (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publisherName: publisher,
        networkFunctionDefinitionGroupName: name,
      };
      const get = getGroup(subscriptionId, resourceGroup, publisher, name);
      const label = `AOSM network function definition group ${name}`;
      const descriptionDiffers = (
        observed: hybridnetwork.GetNetworkFunctionDefinitionGroupResponse,
      ) =>
        news.description !== undefined &&
        observed.properties?.description !== news.description;

      // Observe.
      let observed = yield* get;

      // Ensure (and sync the description, which is only writable by PUT).
      if (observed === undefined || descriptionDiffers(observed)) {
        yield* retryInProgress(
          hybridnetwork.NetworkFunctionDefinitionGroupsCreateOrUpdate({
            ...where,
            location: observed?.location ?? location,
            tags,
            properties: { description: news.description },
          }),
        );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (group) =>
          descriptionDiffers(group)
            ? "Updating"
            : group.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdateNetworkFunctionDefinitionGroup({
            ...where,
            tags,
          }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (group) =>
            tagsDiffer(group.tags, tags)
              ? "Updating"
              : group.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, publisher, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork
          .DeleteNetworkFunctionDefinitionGroup({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            publisherName: output.publisher,
            networkFunctionDefinitionGroupName:
              output.networkFunctionDefinitionGroupName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM network function definition group ${output.networkFunctionDefinitionGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.publisher,
          output.networkFunctionDefinitionGroupName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridNetwork.Publisher",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
