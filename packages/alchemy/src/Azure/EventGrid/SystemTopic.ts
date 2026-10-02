import * as eventgrid from "@distilled.cloud/azure/eventgrid";
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
  createEventGridName,
  identityDiffers,
  sameName,
  toIdentityInfo,
  type EventGridIdentity,
} from "./common.ts";

export interface SystemTopicProps {
  /** Resource group the system topic is created in. Changing it replaces the system topic. */
  resourceGroup: string;
  /**
   * System topic name: 3-128 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the system topic.
   */
  name?: string;
  /**
   * ARM resource ID of the event source, e.g. `account.storageAccountId`
   * or `group.resourceGroupId`. Azure allows one system topic per source.
   * Changing it replaces the system topic.
   */
  source: string;
  /**
   * Topic type of the source, e.g. `Microsoft.Storage.StorageAccounts`,
   * `Microsoft.Resources.ResourceGroups`, `Microsoft.KeyVault.vaults`.
   * Changing it replaces the system topic.
   */
  topicType: string;
  /**
   * Location of the system topic. It must equal the source's region, or
   * `global` for resource-group and subscription sources. Changing it
   * replaces the system topic.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Managed identity of the system topic, used for identity-based delivery. */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
 * An Event Grid system topic — the events an Azure resource (a storage
 * account, resource group, key vault, …) emits. Subscribe to it with
 * `Azure.EventGrid.SystemTopicEventSubscription`.
 *
 * Azure allows only one system topic per source resource.
 *
 * @see https://learn.microsoft.com/azure/event-grid/system-topics
 *
 * ### Creating a System Topic
 * **Example:** Storage account events
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const events = yield* Azure.EventGrid.SystemTopic("files-events", {
 *   resourceGroup: group.resourceGroupName,
 *   source: account.storageAccountId,
 *   topicType: "Microsoft.Storage.StorageAccounts",
 * });
 * ```
 *
 * **Example:** Resource group events
 * ```typescript
 * const events = yield* Azure.EventGrid.SystemTopic("group-events", {
 *   resourceGroup: group.resourceGroupName,
 *   source: group.resourceGroupId,
 *   topicType: "Microsoft.Resources.ResourceGroups",
 *   location: "global",
 * });
 * ```
 *
 * @resource
 */
export const SystemTopic = Resource<SystemTopic>("Azure.EventGrid.SystemTopic");

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

const provisioned = (topic: ObservedSystemTopic) =>
  topic.properties?.provisioningState;

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
      const page = yield* eventgrid
        .ListSystemTopicBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSystemTopicBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((topic) => {
        const group = resourceGroupOf(topic.id);
        return hasAnyAlchemyTag(topic.tags) &&
          group !== undefined &&
          topic.name !== undefined
          ? [toAttrs(group, topic.name, topic)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.systemTopicName) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
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
      const name =
        output?.systemTopicName ??
        olds?.name ??
        (yield* createEventGridName(id, 128));
      const observed = yield* getSystemTopic(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.systemTopicName ??
        (yield* createEventGridName(id, 128));
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
        getSystemTopic(
          subscriptionId,
          output.resourceGroup,
          output.systemTopicName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
