import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createEventGridName,
  identityDiffers,
  ipRulesDiffer,
  redactKeys,
  sameName,
  setIfChanged,
  toIdentityInfo,
  toInputSchemaMapping,
  toIpRules,
  type EventGridIdentity,
  type EventGridInboundIpRule,
} from "./common.ts";

/** Event schema Event Grid expects on publish. */
export type EventGridInputSchema = "EventGridSchema" | "CustomEventSchema" | "CloudEventSchemaV1_0";

/** Maps one Event Grid field to a field of a custom input schema. */
export interface JsonField {
  /**
   * Name of the field in the published event.
   * @default the Event Grid field of the same name
   */
  sourceField?: string;
}

/** Maps one Event Grid field to a custom field, with a fallback value. */
export interface JsonFieldWithDefault extends JsonField {
  /**
   * Value used when the source field is absent.
   * @default no fallback
   */
  defaultValue?: string;
}

/**
 * Field mappings for `CustomEventSchema` input (`JsonInputSchemaMapping`).
 */
export interface JsonInputSchemaMapping {
  /** Source of the event `id`. */
  id?: JsonField;
  /** Source of the event `topic`. */
  topic?: JsonField;
  /** Source of the event `eventTime`. */
  eventTime?: JsonField;
  /** Source of the event `eventType`. */
  eventType?: JsonFieldWithDefault;
  /** Source of the event `subject`. */
  subject?: JsonFieldWithDefault;
  /** Source of the event `dataVersion`. */
  dataVersion?: JsonFieldWithDefault;
}

export interface TopicProps {
  /**
   * Resource group the topic is created in.
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Topic name: 3-50 letters, digits, and hyphens, unique per region. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the topic.
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Schema of published events: `EventGridSchema`, `CloudEventSchemaV1_0`,
   * or `CustomEventSchema` (with `inputSchemaMapping`).
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default "EventGridSchema"
   */
  inputSchema?: EventGridInputSchema;
  /**
   * Field mappings used with `inputSchema: "CustomEventSchema"`.
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default no mapping
   */
  inputSchemaMapping?: JsonInputSchemaMapping;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * IP ranges allowed to publish while `publicNetworkAccess` is `Enabled`.
   * An empty list (the default) allows every address.
   * @default []
   */
  inboundIpRules?: EventGridInboundIpRule[];
  /**
   * Minimum TLS version publishers must use.
   * @default Azure's default (`1.2`)
   */
  minimumTlsVersionAllowed?: "1.0" | "1.1" | "1.2";
  /**
   * Require Microsoft Entra ID to publish (disables SAS keys). When `true`,
   * `primaryKey`/`secondaryKey` are not returned.
   * @default Azure's default (`false`)
   */
  disableLocalAuth?: boolean;
  /**
   * Data residency boundary of the topic.
   * @default Azure's default
   */
  dataResidencyBoundary?: "WithinGeopair" | "WithinRegion";
  /**
   * Managed identity of the topic, used for identity-based delivery
   * (`deliveryIdentity` on an event subscription).
   * @default the observed identity is kept (none on a new topic)
   */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Topic extends Resource<
  "Azure.EventGrid.Topic",
  TopicProps,
  {
    /** Name of the topic. */
    topicName: string;
    /** ARM resource ID of the topic; use it as an event-subscription scope. */
    topicId: string;
    /** Resource group that holds the topic. */
    resourceGroup: string;
    /** Location of the topic. */
    location: string;
    /** Publish endpoint, e.g. `https://{name}.eastus-1.eventgrid.azure.net/api/events`. */
    endpoint: string | undefined;
    /** Metric resource ID of the topic. */
    metricResourceId: string | undefined;
    /** Schema of published events. */
    inputSchema: string;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Primary SAS key (absent when `disableLocalAuth` is `true`). */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key (absent when `disableLocalAuth` is `true`). */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Event Grid custom topic (`Microsoft.EventGrid/topics`): an HTTPS
 * endpoint your applications publish events to. Event Grid pushes each
 * event to every event subscription whose filter matches.
 *
 * Alchemy creates the topic in the stack's resource group with the Event
 * Grid schema. Bind it to a runtime to publish: the publish bindings assign
 * **EventGrid Data Sender** on this topic only, so your code never handles
 * a topic key. The SAS keys are still attributes (`Redacted` secrets) for
 * publishers outside Azure.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, `inputSchema`, or `inputSchemaMapping` replaces the topic]
 * Alchemy creates a new topic with a new endpoint and keys, and deletes the
 * old one with its event subscriptions.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/custom-topics
 *
 * ### Creating a Topic
 * **Example:** Topic with the Event Grid schema
 * ```typescript
 * const orders = yield* Azure.EventGrid.Topic("orders");
 * // orders.endpoint → "https://<name>.<region>-1.eventgrid.azure.net/api/events"
 * ```
 *
 * ### Event Schemas
 * `inputSchema` sets what publishers send: Event Grid events (the
 * default), CloudEvents v1.0, or your own JSON mapped onto Event Grid
 * fields.
 *
 * **Example:** CloudEvents topic
 * ```typescript
 * const orders = yield* Azure.EventGrid.Topic("orders", {
 *   inputSchema: "CloudEventSchemaV1_0",
 * });
 * ```
 *
 * **Example:** Custom schema that maps `{ orderId, kind }` events
 * ```typescript
 * const orders = yield* Azure.EventGrid.Topic("orders", {
 *   inputSchema: "CustomEventSchema",
 *   inputSchemaMapping: {
 *     id: { sourceField: "orderId" },
 *     eventType: { sourceField: "kind", defaultValue: "Order.Custom" },
 *     subject: { defaultValue: "orders" },
 *     dataVersion: { defaultValue: "1.0" },
 *   },
 * });
 * ```
 *
 * ### Authentication and Network Access
 * **Example:** Accept Microsoft Entra ID only
 * ```typescript
 * const orders = yield* Azure.EventGrid.Topic("orders", {
 *   disableLocalAuth: true,
 * });
 * // orders.primaryKey is undefined: SAS keys are off
 * ```
 *
 * **Example:** Allow publishing from one IP range
 * ```typescript
 * const orders = yield* Azure.EventGrid.Topic("orders", {
 *   inboundIpRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * **Example:** Private endpoint only
 * ```typescript
 * const orders = yield* Azure.EventGrid.Topic("orders", {
 *   publicNetworkAccess: "Disabled",
 * });
 * yield* Azure.Network.PrivateEndpoint("orders-endpoint", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: orders.topicId, groupIds: ["topic"] },
 *   ],
 * });
 * ```
 *
 * ### Delivering with a Managed Identity
 * Give the topic an identity, grant it a role on the destination, and
 * subscribe with `deliveryIdentity`.
 *
 * **Example:** Deliver to a Service Bus queue with the topic's identity
 * ```typescript
 * const orders = yield* Azure.EventGrid.Topic("orders", {
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Authorization.RoleAssignment("orders-to-queue-sender", {
 *   scope: queue.queueId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.ServiceBusDataSender,
 *   principalId: orders.principalId.as<string>(),
 * });
 * yield* Azure.EventGrid.EventSubscription("orders-to-queue", {
 *   scope: orders.topicId,
 *   destination: { endpointType: "ServiceBusQueue", resourceId: queue.queueId },
 *   deliveryIdentity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * ### Subscribing to the Topic
 * **Example:** Deliver `Order.Created` events to a Storage queue
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("sink");
 * const inbox = yield* Azure.Storage.Queue("inbox", {
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.EventGrid.EventSubscription("orders-to-inbox", {
 *   scope: orders.topicId,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: inbox.queueName,
 *   },
 *   filter: { includedEventTypes: ["Order.Created"] },
 * });
 * ```
 *
 * ### Binding to a runtime
 * Pick the publish binding that matches the topic's `inputSchema`:
 * `PublishEventGridEvents`, `PublishCloudEventEvents`, or
 * `PublishCustomEventEvents`. Each assigns **EventGrid Data Sender** on this
 * topic only.
 *
 * **Example:** Publish Event Grid events from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Orders;
 *     const publish = yield* Azure.EventGrid.PublishEventGridEvents(topic);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* publish({
 *           body: [
 *             {
 *               id: "order-42",
 *               subject: "orders/42",
 *               eventType: "Order.Created",
 *               eventTime: new Date().toISOString(),
 *               dataVersion: "1.0",
 *               data: { orderId: "42" },
 *             },
 *           ],
 *         });
 *         return HttpServerResponse.text("published", { status: 202 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventGrid.PublishEventGridEventsHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Publish CloudEvents to a CloudEvents topic
 * ```typescript
 * // init
 * const publish = yield* Azure.EventGrid.PublishCloudEventEvents(topic);
 *
 * // runtime
 * yield* publish({
 *   body: [
 *     {
 *       id: "order-42",
 *       source: "/orders",
 *       type: "Order.Created",
 *       specversion: "1.0",
 *       datacontenttype: "application/json",
 *       data: { orderId: "42" },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Publish your own JSON to a custom-schema topic
 * ```typescript
 * // init
 * const publish = yield* Azure.EventGrid.PublishCustomEventEvents(topic);
 *
 * // runtime
 * yield* publish({ body: [{ orderId: "42", kind: "Order.Created" }] });
 * ```
 *
 * ### Event Sources
 * **Example:** Handle the topic's events in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Orders;
 *     yield* Azure.EventGrid.consumeEvents(
 *       "OrderCreated",
 *       { scope: topic.topicId, includedEventTypes: ["Order.Created"] },
 *       (event) => Effect.log(`${event.subject}: ${JSON.stringify(event.data)}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.EventGridEventSource)),
 * ) {}
 * ```
 *
 * @resource
 */
export const Topic = GroupedResource<Topic>("Azure.EventGrid.Topic");

const getTopic = (subscriptionId: string, resourceGroupName: string, topicName: string) =>
  orUndefinedIfNotFound(eventgrid.GetTopic({ subscriptionId, resourceGroupName, topicName }));

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  topicName: string,
  disableLocalAuth: boolean | undefined,
) =>
  disableLocalAuth
    ? Effect.succeed(undefined)
    : orUndefinedIfNotFound(
        eventgrid.ListTopicSharedAccessKeys({
          subscriptionId,
          resourceGroupName,
          topicName,
        }),
      );

type ObservedTopic = Pick<eventgrid.Topic, "id" | "location" | "properties" | "identity" | "tags">;

const toAttrs = (
  resourceGroup: string,
  name: string,
  topic: ObservedTopic,
  keys: { key1?: string; key2?: string } | undefined,
): Topic["Attributes"] => ({
  topicName: name,
  topicId: topic.id ?? "",
  resourceGroup,
  location: topic.location,
  endpoint: topic.properties?.endpoint,
  metricResourceId: topic.properties?.metricResourceId,
  inputSchema: topic.properties?.inputSchema ?? "EventGridSchema",
  principalId: topic.identity?.principalId,
  ...redactKeys(keys),
  tags: userTags(topic.tags),
});

const provisioned = (topic: ObservedTopic) => topic.properties?.provisioningState;

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    stables: ["topicName", "topicId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(eventgrid.ListTopicBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((topic) => {
        const group = resourceGroupOf(topic.id);
        return hasAnyAlchemyTag(topic.tags) && group !== undefined && topic.name !== undefined
          ? [toAttrs(group, topic.name, topic, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.topicName) ||
        (news.location !== undefined && !sameName(news.location, output.location)) ||
        (news.inputSchema ?? "EventGridSchema") !== output.inputSchema ||
        JSON.stringify(news.inputSchemaMapping ?? null) !==
          JSON.stringify(olds?.inputSchemaMapping ?? null)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.topicName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getTopic(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.disableLocalAuth,
      );
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.topicName ?? (yield* createEventGridName(id, 50));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentityInfo(news.identity);
      const inboundIpRules = toIpRules(news.inboundIpRules);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        topicName: name,
      };
      const get = getTopic(subscriptionId, resourceGroup, name);
      const label = `event grid topic ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation; poll until provisioned.
      if (observed === undefined) {
        yield* eventgrid.TopicsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: {
            inputSchema: news.inputSchema ?? "EventGridSchema",
            inputSchemaMapping: toInputSchemaMapping(news.inputSchemaMapping),
            publicNetworkAccess: news.publicNetworkAccess,
            inboundIpRules,
            minimumTlsVersionAllowed: news.minimumTlsVersionAllowed,
            disableLocalAuth: news.disableLocalAuth,
            dataResidencyBoundary: news.dataResidencyBoundary,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, provisioned, {
        times: 60,
      });

      // Sync mutable aspects against observed state; PATCH only the delta.
      const props = observed.properties ?? {};
      const changed: eventgrid.TopicUpdateParameterProperties = {};
      setIfChanged(
        changed,
        "publicNetworkAccess",
        news.publicNetworkAccess,
        props.publicNetworkAccess,
      );
      setIfChanged(
        changed,
        "minimumTlsVersionAllowed",
        news.minimumTlsVersionAllowed,
        props.minimumTlsVersionAllowed,
      );
      setIfChanged(
        changed,
        "disableLocalAuth",
        news.disableLocalAuth,
        props.disableLocalAuth ?? false,
      );
      setIfChanged(
        changed,
        "dataResidencyBoundary",
        news.dataResidencyBoundary,
        props.dataResidencyBoundary,
      );
      if (ipRulesDiffer(props.inboundIpRules, inboundIpRules)) {
        changed.inboundIpRules = inboundIpRules;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (Object.keys(changed).length > 0 || tagsChanged || identityChanged) {
        yield* eventgrid.UpdateTopic({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(label, get, provisioned, {
          times: 60,
        });
      }

      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.disableLocalAuth,
      );
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteTopic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          topicName: output.topicName,
        }),
      );
      yield* waitUntilGone(
        `event grid topic ${output.topicName}`,
        getTopic(subscriptionId, output.resourceGroup, output.topicName),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
