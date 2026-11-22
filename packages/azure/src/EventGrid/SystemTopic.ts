import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
  sameName,
  toIdentityInfo,
  type EventGridIdentity,
} from "./common.ts";

export interface SystemTopicProps {
  /**
   * Resource group the system topic is created in.
   *
   * :::caution
   * Changing it replaces the system topic.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * System topic name: 3-128 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the system topic.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * ARM resource ID of the event source, e.g. `account.storageAccountId`
   * or `group.resourceGroupId`. Azure allows one system topic per source.
   *
   * :::caution
   * Changing it replaces the system topic.
   * :::
   */
  source: string;
  /**
   * Topic type of the source, e.g. `Microsoft.Storage.StorageAccounts`,
   * `Microsoft.Resources.ResourceGroups`, `Microsoft.KeyVault.vaults`.
   *
   * :::caution
   * Changing it replaces the system topic.
   * :::
   */
  topicType: string;
  /**
   * Location of the system topic. It must equal the source's region, or
   * `global` for resource-group and subscription sources.
   *
   * :::caution
   * Changing it replaces the system topic.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Managed identity of the system topic, used for identity-based delivery
   * (`deliveryIdentity` on an event subscription).
   * @default the observed identity is kept (none on a new system topic)
   */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface SystemTopic extends Resource<
  "Azure.EventGrid.SystemTopic",
  SystemTopicProps,
  {
    /** Name of the system topic. */
    systemTopicName: string;
    /** ARM resource ID of the system topic. */
    systemTopicId: string;
    /** Resource group that holds the system topic. */
    resourceGroup: string;
    /** Location of the system topic. */
    location: string;
    /** ARM resource ID of the event source. */
    source: string;
    /** Topic type of the source. */
    topicType: string;
    /** Metric resource ID of the system topic. */
    metricResourceId: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Event Grid system topic (`Microsoft.EventGrid/systemTopics`): the
 * events an Azure resource emits, such as a blob created in a storage
 * account, a resource written in a resource group, or a secret near expiry
 * in a key vault. Route them with
 * `Azure.EventGrid.SystemTopicEventSubscription`.
 *
 * Declare the system topic when you want to own it: its name, tags, and
 * managed identity. `Azure.EventGrid.consumeEvents` and
 * `Azure.EventGrid.EventSubscription` on the source itself work without
 * one.
 *
 * :::caution[Azure allows one system topic per source]
 * Creating a second system topic for the same source fails. An event
 * subscription created directly on the source (for example by
 * `consumeEvents`) makes Azure create one for you.
 * :::
 *
 * :::caution[Changing `name`, `source`, `topicType`, `location`, or `resourceGroup` replaces the system topic]
 * Alchemy deletes the old system topic with its event subscriptions and
 * creates a new one.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/system-topics
 *
 * ### Creating a System Topic
 * **Example:** Storage account events
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files");
 * const fileEvents = yield* Azure.EventGrid.SystemTopic("files-events", {
 *   source: account.storageAccountId,
 *   topicType: "Microsoft.Storage.StorageAccounts",
 *   location: account.location,
 * });
 * ```
 *
 * **Example:** Resource group events
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app", { location: "eastus" });
 * const groupEvents = yield* Azure.EventGrid.SystemTopic("group-events", {
 *   source: group.resourceGroupId,
 *   topicType: "Microsoft.Resources.ResourceGroups",
 *   location: "global",
 * });
 * ```
 *
 * **Example:** Key Vault events
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("secrets");
 * const vaultEvents = yield* Azure.EventGrid.SystemTopic("vault-events", {
 *   source: vault.vaultId,
 *   topicType: "Microsoft.KeyVault.vaults",
 *   location: vault.location,
 * });
 * ```
 *
 * ### Routing Events
 * **Example:** Send new blobs under `uploads/` to a Storage queue
 * ```typescript
 * const jobs = yield* Azure.Storage.Queue("jobs", {
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.EventGrid.SystemTopicEventSubscription("uploads-to-jobs", {
 *   systemTopic: fileEvents.systemTopicName,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: jobs.queueName,
 *   },
 *   filter: {
 *     includedEventTypes: ["Microsoft.Storage.BlobCreated"],
 *     subjectBeginsWith: "/blobServices/default/containers/uploads/",
 *   },
 * });
 * ```
 *
 * **Example:** Dead-letter undeliverable events to a blob container
 * ```typescript
 * const deadLetters = yield* Azure.Storage.BlobContainer("dead-letters", {
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.EventGrid.SystemTopicEventSubscription("uploads-to-hook", {
 *   systemTopic: fileEvents.systemTopicName,
 *   destination: { endpointType: "WebHook", endpointUrl: "https://example.com/events" },
 *   retryPolicy: { maxDeliveryAttempts: 5, eventTimeToLiveInMinutes: 60 },
 *   deadLetterDestination: {
 *     resourceId: account.storageAccountId,
 *     blobContainerName: deadLetters.containerName,
 *   },
 * });
 * ```
 *
 * ### Delivering with a Managed Identity
 * **Example:** Deliver to a Service Bus queue with the system topic's identity
 * ```typescript
 * const fileEvents = yield* Azure.EventGrid.SystemTopic("files-events", {
 *   source: account.storageAccountId,
 *   topicType: "Microsoft.Storage.StorageAccounts",
 *   location: account.location,
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Authorization.RoleAssignment("files-events-sender", {
 *   scope: queue.queueId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.ServiceBusDataSender,
 *   principalId: fileEvents.principalId.as<string>(),
 * });
 * yield* Azure.EventGrid.SystemTopicEventSubscription("files-to-bus", {
 *   systemTopic: fileEvents.systemTopicName,
 *   destination: { endpointType: "ServiceBusQueue", resourceId: queue.queueId },
 *   deliveryIdentity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * ### Event Sources
 * `consumeEvents` subscribes a Function to the source directly. Pass the
 * source resource ID as `scope`.
 *
 * **Example:** React to new blobs in an Azure Function
 * ```typescript
 * export default class Thumbnails extends Azure.Functions.Function<Thumbnails>()(
 *   "Thumbnails",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const account = yield* Files;
 *     yield* Azure.EventGrid.consumeEvents(
 *       "BlobCreated",
 *       {
 *         scope: account.storageAccountId,
 *         includedEventTypes: ["Microsoft.Storage.BlobCreated"],
 *         subjectEndsWith: ".png",
 *       },
 *       (event) => Effect.log(`new image ${event.subject}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.EventGridEventSource)),
 * ) {}
 * ```
 *
 * @resource
 */
export const SystemTopic = GroupedResource<SystemTopic>("Azure.EventGrid.SystemTopic");

type ObservedSystemTopic = Pick<
  eventgrid.SystemTopic,
  "id" | "location" | "properties" | "identity" | "tags"
>;

const getSystemTopic = (
  subscriptionId: string,
  resourceGroupName: string,
  systemTopicName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetSystemTopic({
      subscriptionId,
      resourceGroupName,
      systemTopicName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  topic: ObservedSystemTopic,
): SystemTopic["Attributes"] => ({
  systemTopicName: name,
  systemTopicId: topic.id ?? "",
  resourceGroup,
  location: topic.location,
  source: topic.properties?.source ?? "",
  topicType: topic.properties?.topicType ?? "",
  metricResourceId: topic.properties?.metricResourceId,
  principalId: topic.identity?.principalId,
  tags: userTags(topic.tags),
});

const provisioned = (topic: ObservedSystemTopic) => topic.properties?.provisioningState;

export const SystemTopicProvider = () =>
  Provider.succeed(SystemTopic, {
    stables: [
      "systemTopicName",
      "systemTopicId",
      "resourceGroup",
      "location",
      "source",
      "topicType",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(eventgrid.ListSystemTopicBySubscription, { subscriptionId });
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
        (news.name !== undefined && news.name !== output.systemTopicName) ||
        (news.location !== undefined && !sameName(news.location, output.location)) ||
        !sameName(news.source, output.source) ||
        !sameName(news.topicType, output.topicType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.systemTopicName ?? olds?.name ?? (yield* createEventGridName(id, 128));
      const observed = yield* getSystemTopic(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.systemTopicName ?? (yield* createEventGridName(id, 128));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentityInfo(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        systemTopicName: name,
      };
      const get = getSystemTopic(subscriptionId, resourceGroup, name);
      const label = `event grid system topic ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* eventgrid.SystemTopicsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: { source: news.source, topicType: news.topicType },
        });
      }
      observed = yield* waitForProvisioned(label, get, provisioned, {
        times: 60,
      });

      // Sync tags and identity against observed state.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (tagsChanged || identityChanged) {
        yield* eventgrid.UpdateSystemTopic({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
        });
        observed = yield* waitForProvisioned(label, get, provisioned, {
          times: 60,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteSystemTopic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          systemTopicName: output.systemTopicName,
        }),
      );
      yield* waitUntilGone(
        `event grid system topic ${output.systemTopicName}`,
        getSystemTopic(subscriptionId, output.resourceGroup, output.systemTopicName),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
