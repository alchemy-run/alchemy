import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEventGridName, sameName } from "./common.ts";

/** An event type a partner topic advertises to its subscriber. */
export interface PartnerEventType {
  /** Display name shown to the subscriber (required by Event Grid). */
  displayName: string;
  /** Description of the event type. */
  description?: string;
  /** Documentation URL of the event type. */
  documentationUrl?: string;
  /** URL of the JSON schema of the event `data`. */
  dataSchemaUrl?: string;
}

/** Where a channel creates its partner topic (the subscriber's side). */
export interface ChannelPartnerTopic {
  /**
   * Azure subscription of the subscriber. Changing it replaces the channel.
   * @default the current subscription
   */
  subscriptionId?: string;
  /**
   * Subscriber resource group the partner topic is created in. Its
   * `Azure.EventGrid.PartnerConfiguration` must authorize the partner
   * registration. Changing it replaces the channel.
   */
  resourceGroup: string;
  /**
   * Name of the partner topic. Changing it replaces the channel.
   * @default the channel name
   */
  name?: string;
  /**
   * Partner resource the events come from, shown to the subscriber during
   * activation. Changing it replaces the channel.
   */
  source: string;
}

export interface ChannelProps {
  /**
   * Resource group of the partner namespace. Changing it replaces the
   * channel.
   */
  resourceGroup: string;
  /** Name of the parent partner namespace. Changing it replaces the channel. */
  partnerNamespace: string;
  /**
   * Channel name: 3-50 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the channel.
   */
  name?: string;
  /**
   * The partner topic the channel creates in the subscriber's resource
   * group.
   *
   * :::caution
   * Changing any field replaces the channel; the old partner topic is
   * deleted and the subscriber must activate the new one.
   * :::
   */
  partnerTopic: ChannelPartnerTopic;
  /**
   * Event types the partner topic advertises, keyed by event type name
   * (e.g. `Contoso.OrderCreated`). Updated in place.
   * @default no advertised event types
   */
  eventTypes?: Record<string, PartnerEventType>;
  /**
   * Message shown to the subscriber when they activate the partner topic.
   *
   * :::caution
   * Changing it replaces the channel.
   * :::
   */
  messageForActivation?: string;
  /**
   * When the channel and its partner topic are deleted if the subscriber
   * never activates the topic (ISO 8601). Only applies before activation.
   * @default Azure's default (7 days after creation)
   */
  expirationTimeIfNotActivatedUtc?: string;
}

export interface Channel extends Resource<
  "Azure.EventGrid.Channel",
  ChannelProps,
  {
    /** Name of the channel. */
    channelName: string;
    /** ARM resource ID of the channel. */
    channelId: string;
    /** Resource group of the partner namespace. */
    resourceGroup: string;
    /** Name of the parent partner namespace. */
    partnerNamespace: string;
    /** Subscription of the partner topic. */
    partnerTopicSubscriptionId: string;
    /** Resource group of the partner topic. */
    partnerTopicResourceGroup: string;
    /** Name of the partner topic; pass it to `Azure.EventGrid.PartnerTopic`. */
    partnerTopicName: string;
    /** Source of the partner topic. */
    source: string | undefined;
    /** Whether the subscriber activated the partner topic (`NeverActivated` or `Activated`). */
    readinessState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Event Grid channel (`Microsoft.EventGrid/partnerNamespaces/channels`)
 * — the partner-side link from a partner namespace to one subscriber. On
 * creation it creates a partner topic in the subscriber's resource group;
 * the subscriber then activates it with `Azure.EventGrid.PartnerTopic`.
 *
 * The subscriber's resource group must authorize the partner registration
 * with an `Azure.EventGrid.PartnerConfiguration` first.
 *
 * Channels have no tags; Alchemy tracks them through stack state.
 *
 * @see https://learn.microsoft.com/azure/event-grid/onboard-partner
 *
 * ### Creating a Channel
 * **Example:** Channel that creates a partner topic for a customer
 * ```typescript
 * const channel = yield* Azure.EventGrid.Channel("customer-a", {
 *   partnerNamespace: namespace.partnerNamespaceName,
 *   partnerTopic: {
 *     resourceGroup: "customer-a-events",
 *     source: "contoso/tenants/customer-a",
 *   },
 *   eventTypes: {
 *     "Contoso.OrderCreated": { displayName: "Order created" },
 *   },
 *   messageForActivation: "Activate to receive Contoso order events.",
 * });
 * ```
 *
 * @resource
 */
export const Channel = GroupedResource<Channel>("Azure.EventGrid.Channel");

type ObservedChannel = Pick<eventgrid.Channel, "id" | "properties">;

const getChannel = (
  subscriptionId: string,
  resourceGroupName: string,
  partnerNamespaceName: string,
  channelName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetChannel({
      subscriptionId,
      resourceGroupName,
      partnerNamespaceName,
      channelName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  partnerNamespace: string,
  name: string,
  topic: { subscriptionId: string; resourceGroup: string; name: string },
  observed: ObservedChannel,
): Channel["Attributes"] => {
  const info = observed.properties?.partnerTopicInfo;
  return {
    channelName: name,
    channelId: observed.id ?? "",
    resourceGroup,
    partnerNamespace,
    partnerTopicSubscriptionId: info?.azureSubscriptionId ?? topic.subscriptionId,
    partnerTopicResourceGroup: info?.resourceGroupName ?? topic.resourceGroup,
    partnerTopicName: info?.name ?? topic.name,
    source: info?.source,
    readinessState: observed.properties?.readinessState,
  };
};

/** Desired event types in wire form. */
const toEventTypeInfo = (
  eventTypes: Record<string, PartnerEventType> | undefined,
): eventgrid.EventTypeInfo | undefined =>
  eventTypes === undefined ? undefined : { kind: "Inline", inlineEventTypes: eventTypes };

/** Canonical JSON of inline event types (sorted keys, unset fields dropped). */
const canonicalEventTypes = (
  eventTypes: Readonly<Record<string, eventgrid.InlineEventProperties | undefined>>,
) =>
  JSON.stringify(
    Object.keys(eventTypes)
      .sort()
      .map((key) => {
        const value = eventTypes[key] ?? {};
        return [
          key,
          value.displayName ?? null,
          value.description ?? null,
          value.documentationUrl ?? null,
          value.dataSchemaUrl ?? null,
        ];
      }),
  );

const provisioned = (channel: ObservedChannel) => channel.properties?.provisioningState;

export const ChannelProvider = () =>
  Provider.succeed(Channel, {
    stables: [
      "channelName",
      "channelId",
      "resourceGroup",
      "partnerNamespace",
      "partnerTopicSubscriptionId",
      "partnerTopicResourceGroup",
      "partnerTopicName",
    ],

    // Channels have no tags and are deleted with their partner namespace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const topic = news.partnerTopic;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.partnerNamespace, output.partnerNamespace) ||
        (news.name !== undefined && news.name !== output.channelName) ||
        (topic.subscriptionId !== undefined &&
          !sameName(topic.subscriptionId, output.partnerTopicSubscriptionId)) ||
        !sameName(topic.resourceGroup, output.partnerTopicResourceGroup) ||
        (topic.name ?? news.name ?? output.channelName) !== output.partnerTopicName ||
        topic.source !== output.source ||
        (olds !== undefined && news.messageForActivation !== olds.messageForActivation)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const partnerNamespace = output?.partnerNamespace ?? olds?.partnerNamespace;
      if (resourceGroup === undefined || partnerNamespace === undefined) {
        return undefined;
      }
      const name = output?.channelName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getChannel(subscriptionId, resourceGroup, partnerNamespace, name);
      if (observed === undefined) return undefined;
      const topic = {
        subscriptionId: output?.partnerTopicSubscriptionId ?? subscriptionId,
        resourceGroup: output?.partnerTopicResourceGroup ?? olds?.partnerTopic.resourceGroup ?? "",
        name: output?.partnerTopicName ?? olds?.partnerTopic.name ?? name,
      };
      return toAttrs(resourceGroup, partnerNamespace, name, topic, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, partnerNamespace } = news;
      const name = news.name ?? output?.channelName ?? (yield* createEventGridName(id, 50));
      const topic = {
        subscriptionId: news.partnerTopic.subscriptionId ?? subscriptionId,
        resourceGroup: news.partnerTopic.resourceGroup,
        name: news.partnerTopic.name ?? name,
      };
      const eventTypeInfo = toEventTypeInfo(news.eventTypes);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        partnerNamespaceName: partnerNamespace,
        channelName: name,
      };
      const get = getChannel(subscriptionId, resourceGroup, partnerNamespace, name);
      const label = `event grid channel ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creating the channel also creates the partner topic.
      if (observed === undefined) {
        yield* eventgrid.ChannelsCreateOrUpdate({
          ...where,
          properties: {
            channelType: "PartnerTopic",
            messageForActivation: news.messageForActivation,
            expirationTimeIfNotActivatedUtc: news.expirationTimeIfNotActivatedUtc,
            partnerTopicInfo: {
              azureSubscriptionId: topic.subscriptionId,
              resourceGroupName: topic.resourceGroup,
              name: topic.name,
              source: news.partnerTopic.source,
              eventTypeInfo,
            },
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, provisioned);

      // Sync. PATCH covers the advertised event types and, before
      // activation, the expiry.
      const props = observed.properties;
      const patch: eventgrid.ChannelUpdateParametersProperties = {};
      if (
        news.eventTypes !== undefined &&
        canonicalEventTypes(news.eventTypes) !==
          canonicalEventTypes(props?.partnerTopicInfo?.eventTypeInfo?.inlineEventTypes ?? {})
      ) {
        patch.partnerTopicInfo = { eventTypeInfo };
      }
      if (
        news.expirationTimeIfNotActivatedUtc !== undefined &&
        props?.readinessState !== "Activated" &&
        Date.parse(news.expirationTimeIfNotActivatedUtc) !==
          Date.parse(props?.expirationTimeIfNotActivatedUtc ?? "")
      ) {
        patch.expirationTimeIfNotActivatedUtc = news.expirationTimeIfNotActivatedUtc;
      }
      if (Object.keys(patch).length > 0) {
        yield* eventgrid.UpdateChannel({ ...where, properties: patch });
        observed = yield* waitForProvisioned(label, get, provisioned);
      }

      return toAttrs(resourceGroup, partnerNamespace, name, topic, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteChannel({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          partnerNamespaceName: output.partnerNamespace,
          channelName: output.channelName,
        }),
      );
      yield* waitUntilGone(
        `event grid channel ${output.channelName}`,
        getChannel(
          subscriptionId,
          output.resourceGroup,
          output.partnerNamespace,
          output.channelName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.PartnerNamespace"] },
  });
