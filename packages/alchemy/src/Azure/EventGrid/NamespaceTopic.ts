import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEventGridName, redactKeys, sameName } from "./common.ts";

export interface NamespaceTopicProps {
  /** Resource group of the namespace. Changing it replaces the topic. */
  resourceGroup: string;
  /** Name of the parent Event Grid namespace. Changing it replaces the topic. */
  namespace: string;
  /**
   * Topic name: 3-50 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the topic.
   */
  name?: string;
  /**
   * Days events are retained for pull delivery (1-7).
   * @default Azure's default (`7`)
   */
  eventRetentionInDays?: number;
}

export interface NamespaceTopic extends Resource<
  "Azure.EventGrid.NamespaceTopic",
  NamespaceTopicProps,
  {
    /** Name of the topic. */
    namespaceTopicName: string;
    /** ARM resource ID of the topic. */
    namespaceTopicId: string;
    /** Name of the parent namespace. */
    namespace: string;
    /** Resource group of the parent namespace. */
    resourceGroup: string;
    /** Days events are retained. */
    eventRetentionInDays: number | undefined;
    /** Primary SAS key of the topic. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key of the topic. */
    secondaryKey: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A topic in an Event Grid namespace. It accepts CloudEvents (v1.0) from
 * custom publishers and delivers them to namespace event subscriptions by
 * pull (queue) or push.
 *
 * Namespace topics have no tags; ownership follows the parent namespace.
 *
 * @see https://learn.microsoft.com/azure/event-grid/concepts-event-grid-namespaces
 *
 * ### Creating a Namespace Topic
 * **Example:** Topic that retains events for one day
 * ```typescript
 * const namespace = yield* Azure.EventGrid.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const orders = yield* Azure.EventGrid.NamespaceTopic("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   eventRetentionInDays: 1,
 * });
 * ```
 *
 * @resource
 */
export const NamespaceTopic = Resource<NamespaceTopic>(
  "Azure.EventGrid.NamespaceTopic",
);

const getNamespaceTopic = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetNamespaceTopic({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
    }),
  );

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.ListNamespaceTopicSharedAccessKeys({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  topic: Pick<eventgrid.NamespaceTopic, "id" | "properties">,
  keys: { key1?: string; key2?: string } | undefined,
): NamespaceTopic["Attributes"] => ({
  namespaceTopicName: name,
  namespaceTopicId: topic.id ?? "",
  namespace,
  resourceGroup,
  eventRetentionInDays: topic.properties?.eventRetentionInDays,
  ...redactKeys(keys),
});

export const NamespaceTopicProvider = () =>
  Provider.succeed(NamespaceTopic, {
    stables: [
      "namespaceTopicName",
      "namespaceTopicId",
      "namespace",
      "resourceGroup",
    ],

    // Namespace topics are deleted with their namespace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespace) ||
        (news.name !== undefined && news.name !== output.namespaceTopicName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // Namespace topics carry no tags; ownership follows the parent namespace.
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const name =
        output?.namespaceTopicName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
      const observed = yield* getNamespaceTopic(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      return toAttrs(resourceGroup, namespace, name, observed, keys);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, namespace } = news;
      const name =
        news.name ??
        output?.namespaceTopicName ??
        (yield* createEventGridName(id, 50));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: namespace,
        topicName: name,
      };
      const get = getNamespaceTopic(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      const label = `event grid namespace topic ${name}`;
      const stateOf = (topic: Pick<eventgrid.NamespaceTopic, "properties">) =>
        topic.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* eventgrid.NamespaceTopicsCreateOrUpdate({
          ...where,
          properties: {
            publisherType: "Custom",
            inputSchema: "CloudEventSchemaV1_0",
            eventRetentionInDays: news.eventRetentionInDays,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, { times: 60 });

      // Sync retention against observed state.
      if (
        news.eventRetentionInDays !== undefined &&
        observed.properties?.eventRetentionInDays !== news.eventRetentionInDays
      ) {
        yield* eventgrid.UpdateNamespaceTopic({
          ...where,
          properties: { eventRetentionInDays: news.eventRetentionInDays },
        });
        observed = yield* waitForProvisioned(label, get, stateOf, {
          times: 60,
        });
      }

      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      return toAttrs(resourceGroup, namespace, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteNamespaceTopic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          topicName: output.namespaceTopicName,
        }),
      );
      yield* waitUntilGone(
        `event grid namespace topic ${output.namespaceTopicName}`,
        getNamespaceTopic(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.namespaceTopicName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Namespace"] },
  });
