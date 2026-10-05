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

export interface NetworkServiceDesignGroupProps {
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
  /** Description of the network service design group. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkServiceDesignGroup extends Resource<
  "Azure.HybridNetwork.NetworkServiceDesignGroup",
  NetworkServiceDesignGroupProps,
  {
    /** Name of the group. */
    networkServiceDesignGroupName: string;
    /** ARM resource ID of the group. */
    networkServiceDesignGroupId: string;
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
 * An Azure Operator Service Manager network service design group — a
 * publisher-scoped container for the versions
 * (`NetworkServiceDesignVersion`) of one network service.
 *
 * Groups are free metadata resources.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/network-service-design-version-overview
 *
 * ### Creating a Group
 * **Example:** Network function definition group
 * ```typescript
 * const nsdg = yield* Azure.HybridNetwork.NetworkServiceDesignGroup(
 *   "edge-service",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     publisher: publisher.publisherName,
 *     description: "Edge network service",
 *   },
 * );
 * ```
 *
 * @resource
 */
export const NetworkServiceDesignGroup = Resource<NetworkServiceDesignGroup>(
  "Azure.HybridNetwork.NetworkServiceDesignGroup",
);

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  publisherName: string,
  networkServiceDesignGroupName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetNetworkServiceDesignGroup({
      subscriptionId,
      resourceGroupName,
      publisherName,
      networkServiceDesignGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  publisher: string,
  name: string,
  group:
    | hybridnetwork.GetNetworkServiceDesignGroupResponse
    | hybridnetwork.NetworkServiceDesignGroup,
): NetworkServiceDesignGroup["Attributes"] => ({
  networkServiceDesignGroupName: name,
  networkServiceDesignGroupId: group.id ?? "",
  publisher,
  resourceGroup,
  location: group.location,
  description: group.properties?.description,
  tags: userTags(group.tags),
});

export const NetworkServiceDesignGroupProvider = () =>
  Provider.succeed(NetworkServiceDesignGroup, {
    stables: [
      "networkServiceDesignGroupName",
      "networkServiceDesignGroupId",
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
      const found: NetworkServiceDesignGroup["Attributes"][] = [];
      for (const publisher of publishers.value ?? []) {
        const group = resourceGroupOf(publisher.id);
        if (group === undefined || publisher.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          hybridnetwork.ListNetworkServiceDesignGroupByPublisher({
            subscriptionId,
            resourceGroupName: group,
            publisherName: publisher.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage(
            "ListNetworkServiceDesignGroupByPublisher",
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
          news.name !== output.networkServiceDesignGroupName) ||
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
        output?.networkServiceDesignGroupName ??
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
        output?.networkServiceDesignGroupName ??
        (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publisherName: publisher,
        networkServiceDesignGroupName: name,
      };
      const get = getGroup(subscriptionId, resourceGroup, publisher, name);
      const label = `AOSM network service design group ${name}`;
      const descriptionDiffers = (
        observed: hybridnetwork.GetNetworkServiceDesignGroupResponse,
      ) =>
        news.description !== undefined &&
        observed.properties?.description !== news.description;

      // Observe.
      let observed = yield* get;

      // Ensure (and sync the description, which is only writable by PUT).
      if (observed === undefined || descriptionDiffers(observed)) {
        yield* retryInProgress(
          hybridnetwork.NetworkServiceDesignGroupsCreateOrUpdate({
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
          hybridnetwork.UpdateNetworkServiceDesignGroup({
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
          .DeleteNetworkServiceDesignGroup({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            publisherName: output.publisher,
            networkServiceDesignGroupName: output.networkServiceDesignGroupName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM network service design group ${output.networkServiceDesignGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.publisher,
          output.networkServiceDesignGroupName,
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
