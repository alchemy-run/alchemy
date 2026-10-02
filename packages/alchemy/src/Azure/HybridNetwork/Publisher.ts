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
  type HybridNetworkIdentity,
  identityDiffers,
  identityRequest,
  NAMESPACE,
  sameArm,
  retryInProgress,
} from "./Common.ts";

export type PublisherIdentity = HybridNetworkIdentity;

export interface PublisherProps {
  /** Resource group the publisher is created in. Changing it replaces the publisher. */
  resourceGroup: string;
  /**
   * Publisher name: 1-64 letters, digits, `_`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the publisher.
   */
  name?: string;
  /**
   * Azure location of the publisher. AOSM is available in `eastus`,
   * `southcentralus`, `westus3`, and `uksouth`. Changing it replaces the
   * publisher.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Publisher scope. Only `Private` publishers can be created. Changing it
   * replaces the publisher.
   * @default "Private"
   */
  scope?: "Private";
  /** Managed identity of the publisher. */
  identity?: PublisherIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Publisher extends Resource<
  "Azure.HybridNetwork.Publisher",
  PublisherProps,
  {
    /** Name of the publisher. */
    publisherName: string;
    /** ARM resource ID of the publisher. */
    publisherId: string;
    /** Resource group that holds the publisher. */
    resourceGroup: string;
    /** Location of the publisher. */
    location: string;
    /** Publisher scope. */
    scope: string;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Provisioning state reported by AOSM. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager (AOSM) publisher — the top-level
 * container a network function vendor uses to publish artifact stores,
 * network function definitions, network service designs, and
 * configuration group schemas.
 *
 * Publishers are free metadata resources.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/publisher-resource-preview-management
 *
 * ### Creating a Publisher
 * **Example:** Private publisher
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("aosm", {
 *   location: "eastus",
 * });
 * const publisher = yield* Azure.HybridNetwork.Publisher("publisher", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 * });
 * ```
 *
 * **Example:** Publisher with a system-assigned identity
 * ```typescript
 * const publisher = yield* Azure.HybridNetwork.Publisher("publisher", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 *   tags: { team: "network" },
 * });
 * ```
 *
 * @resource
 */
export const Publisher = Resource<Publisher>("Azure.HybridNetwork.Publisher");

type Observed = hybridnetwork.GetPublisherResponse;

const getPublisher = (
  subscriptionId: string,
  resourceGroupName: string,
  publisherName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetPublisher({
      subscriptionId,
      resourceGroupName,
      publisherName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  publisher: Observed | hybridnetwork.Publisher,
): Publisher["Attributes"] => ({
  publisherName: name,
  publisherId: publisher.id ?? "",
  resourceGroup,
  location: publisher.location,
  scope: publisher.properties?.scope ?? "Private",
  principalId: publisher.identity?.principalId,
  provisioningState: publisher.properties?.provisioningState,
  tags: userTags(publisher.tags),
});

export const PublisherProvider = () =>
  Provider.succeed(Publisher, {
    stables: [
      "publisherName",
      "publisherId",
      "resourceGroup",
      "location",
      "scope",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridnetwork
        .ListPublisherBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPublisherBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((publisher) => {
        const group = resourceGroupOf(publisher.id);
        return hasAnyAlchemyTag(publisher.tags) &&
          group !== undefined &&
          publisher.name !== undefined
          ? [toAttrs(group, publisher.name, publisher)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.publisherName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (news.scope ?? "Private") !== output.scope
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
        output?.publisherName ??
        olds?.name ??
        (yield* createHybridNetworkName(id));
      const observed = yield* getPublisher(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.publisherName ??
        (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publisherName: name,
      };
      const get = getPublisher(subscriptionId, resourceGroup, name);
      const label = `AOSM publisher ${name}`;
      const put = (location: string) =>
        retryInProgress(
          hybridnetwork.PublishersCreateOrUpdate({
            ...where,
            location,
            tags,
            identity: identityRequest(news.identity),
            properties: { scope: news.scope ?? "Private" },
          }),
        );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* put(location);
      } else if (identityDiffers(observed.identity, news.identity)) {
        // Identity is only writable through a full PUT.
        yield* put(observed.location);
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (publisher) =>
          identityDiffers(publisher.identity, news.identity)
            ? "Updating"
            : publisher.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdatePublisher({ ...where, tags }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (publisher) =>
            tagsDiffer(publisher.tags, tags)
              ? "Updating"
              : publisher.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork
          .DeletePublisher({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            publisherName: output.publisherName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM publisher ${output.publisherName}`,
        getPublisher(
          subscriptionId,
          output.resourceGroup,
          output.publisherName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
