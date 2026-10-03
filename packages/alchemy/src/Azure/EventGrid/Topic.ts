import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
export type EventGridInputSchema =
  | "EventGridSchema"
  | "CustomEventSchema"
  | "CloudEventSchemaV1_0";

/** Maps one Event Grid field to a field of a custom input schema. */
export interface JsonField {
  /** Name of the field in the published event. */
  sourceField?: string;
}

/** Maps one Event Grid field to a custom field, with a fallback value. */
export interface JsonFieldWithDefault extends JsonField {
  /** Value used when the source field is absent. */
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
  /** Resource group the topic is created in. Changing it replaces the topic. */
  resourceGroup: string;
  /**
   * Topic name: 3-50 letters, digits, and hyphens, unique per region. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the topic.
   */
  name?: string;
  /**
   * Azure location of the topic. Changing it replaces the topic.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Schema of published events. Immutable: changing it replaces the topic.
   * @default "EventGridSchema"
   */
  inputSchema?: EventGridInputSchema;
  /**
   * Field mappings used with `inputSchema: "CustomEventSchema"`. Changing
   * it replaces the topic.
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
  /** Managed identity of the topic, used for identity-based delivery. */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
 * An Event Grid custom topic — an endpoint your applications publish events
 * to, fanned out to event subscriptions.
 *
 * @see https://learn.microsoft.com/azure/event-grid/custom-topics
 *
 * ### Creating a Topic
 * **Example:** Topic with the Event Grid schema
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const topic = yield* Azure.EventGrid.Topic("orders", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** CloudEvents topic that requires Entra ID
 * ```typescript
 * const topic = yield* Azure.EventGrid.Topic("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   inputSchema: "CloudEventSchemaV1_0",
 *   disableLocalAuth: true,
 * });
 * ```
 *
 * ### Network Restrictions
 * **Example:** Allow publishing from one range only
 * ```typescript
 * const topic = yield* Azure.EventGrid.Topic("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   inboundIpRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * @resource
 */
export const Topic = Resource<Topic>("Azure.EventGrid.Topic");

const getTopic = (
  subscriptionId: string,
  resourceGroupName: string,
  topicName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetTopic({ subscriptionId, resourceGroupName, topicName }),
  );

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

type ObservedTopic = Pick<
  eventgrid.Topic,
  "id" | "location" | "properties" | "identity" | "tags"
>;

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

const provisioned = (topic: ObservedTopic) =>
  topic.properties?.provisioningState;

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    stables: ["topicName", "topicId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* eventgrid
        .ListTopicBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListTopicBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((topic) => {
        const group = resourceGroupOf(topic.id);
        return hasAnyAlchemyTag(topic.tags) &&
          group !== undefined &&
          topic.name !== undefined
          ? [toAttrs(group, topic.name, topic, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.topicName) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
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
      const name =
        output?.topicName ?? olds?.name ?? (yield* createEventGridName(id, 50));
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
      const name =
        news.name ?? output?.topicName ?? (yield* createEventGridName(id, 50));
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
