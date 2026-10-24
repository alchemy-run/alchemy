import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
import { GroupedResource } from "../StackResourceGroup.ts";
import { identityDiffers, sameName, toIdentityInfo, type EventGridIdentity } from "./common.ts";

export interface PartnerTopicProps {
  /**
   * Resource group the partner created the topic in. Changing it replaces
   * the partner topic.
   */
  resourceGroup: string;
  /**
   * Name of the partner topic the partner's channel created, e.g.
   * `channel.partnerTopicName` of an `Azure.EventGrid.Channel`.
   *
   * :::caution
   * Changing it replaces the partner topic: Alchemy deletes the old one.
   * :::
   */
  name: string;
  /** Managed identity of the partner topic, used for identity-based delivery. */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PartnerTopic extends Resource<
  "Azure.EventGrid.PartnerTopic",
  PartnerTopicProps,
  {
    /** Name of the partner topic. */
    partnerTopicName: string;
    /** ARM resource ID of the partner topic. */
    partnerTopicId: string;
    /** Resource group that holds the partner topic. */
    resourceGroup: string;
    /** Location of the partner topic (the partner namespace's region). */
    location: string;
    /** Partner resource the events come from. */
    source: string | undefined;
    /** Immutable ID of the publishing partner registration. */
    partnerRegistrationImmutableId: string | undefined;
    /** Activation state (`Activated` once reconciled). */
    activationState: string | undefined;
    /** Event types the partner advertises. */
    eventTypes: string[];
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Event Grid partner topic (`Microsoft.EventGrid/partnerTopics`) — the
 * subscriber side of partner events. A SaaS partner's channel creates the
 * topic in your resource group; this resource claims it, activates it so
 * events flow, and manages its tags and identity. Route its events with
 * `Azure.EventGrid.PartnerTopicEventSubscription`.
 *
 * Partner topics cannot be created directly: the reconcile waits up to
 * about a minute for the partner's channel to create the topic. Activation
 * is one-way (Event Grid cannot deactivate a partner topic). Deleting the
 * partner topic also deletes the partner's channel.
 *
 * @see https://learn.microsoft.com/azure/event-grid/subscribe-to-partner-events
 *
 * ### Activating a Partner Topic
 * **Example:** Activate the topic a partner created
 * ```typescript
 * const partners = yield* Azure.EventGrid.PartnerConfiguration("partners", {
 *   authorizedPartners: [
 *     { partnerRegistrationImmutableId: "941a5b43-6d4c-4d3c-9c9e-2c1d4b8a7f10" },
 *   ],
 * });
 * const topic = yield* Azure.EventGrid.PartnerTopic("orders", {
 *   name: "contoso-orders",
 * });
 * ```
 *
 * **Example:** Activate with a system-assigned identity
 * ```typescript
 * const topic = yield* Azure.EventGrid.PartnerTopic("orders", {
 *   name: "contoso-orders",
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const PartnerTopic = GroupedResource<PartnerTopic>("Azure.EventGrid.PartnerTopic");

type ObservedPartnerTopic = Pick<
  eventgrid.PartnerTopic,
  "id" | "location" | "properties" | "identity" | "tags"
>;

const getPartnerTopic = (
  subscriptionId: string,
  resourceGroupName: string,
  partnerTopicName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetPartnerTopic({ subscriptionId, resourceGroupName, partnerTopicName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedPartnerTopic,
): PartnerTopic["Attributes"] => ({
  partnerTopicName: name,
  partnerTopicId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  source: observed.properties?.source,
  partnerRegistrationImmutableId: observed.properties?.partnerRegistrationImmutableId,
  activationState: observed.properties?.activationState,
  eventTypes: Object.keys(observed.properties?.eventTypeInfo?.inlineEventTypes ?? {}).sort(),
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

const provisioned = (topic: ObservedPartnerTopic) => topic.properties?.provisioningState;

export const PartnerTopicProvider = () =>
  Provider.succeed(PartnerTopic, {
    stables: ["partnerTopicName", "partnerTopicId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* eventgrid
        .ListPartnerTopicBySubscription({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListPartnerTopicBySubscription", page)));
      return (page.value ?? []).flatMap((topic) => {
        const group = resourceGroupOf(topic.id);
        return hasAnyAlchemyTag(topic.tags) && group !== undefined && topic.name !== undefined
          ? [toAttrs(group, topic.name, topic)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        news.name !== output.partnerTopicName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const name = output?.partnerTopicName ?? olds?.name;
      if (resourceGroup === undefined || name === undefined) return undefined;
      const observed = yield* getPartnerTopic(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      // A partner's channel always creates the topic, so a topic no stack
      // has claimed yet is ours to claim; one claimed by another is not.
      if (!hasAnyAlchemyTag(observed.tags)) return attrs;
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, name } = news;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        partnerTopicName: name,
      };
      const get = getPartnerTopic(subscriptionId, resourceGroup, name);
      const label = `event grid partner topic ${name}`;

      // Observe + ensure. Only the partner's channel can create the topic:
      // wait for it to appear rather than create it.
      let observed = yield* waitForProvisioned(label, get, provisioned, { times: 20 });

      // Sync activation (one-way).
      if (observed.properties?.activationState !== "Activated") {
        yield* eventgrid.ActivatePartnerTopic(where);
        observed = yield* waitForProvisioned(label, get, provisioned);
      }

      // Sync tags and identity; PATCH only the delta.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (tagsChanged || identityChanged) {
        yield* eventgrid.UpdatePartnerTopic({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? toIdentityInfo(news.identity) : undefined,
        });
        observed = yield* waitForProvisioned(label, get, provisioned);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeletePartnerTopic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          partnerTopicName: output.partnerTopicName,
        }),
      );
      yield* waitUntilGone(
        `event grid partner topic ${output.partnerTopicName}`,
        getPartnerTopic(subscriptionId, output.resourceGroup, output.partnerTopicName),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
