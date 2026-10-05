import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
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
import {
  createEntityName,
  ownershipMarker,
  stripMarker,
  withMarker,
} from "./Common.ts";

export interface ConsumerGroupProps {
  /** Resource group of the namespace. Changing it replaces the consumer group. */
  resourceGroup: string;
  /** Namespace of the event hub. Changing it replaces the consumer group. */
  namespace: string;
  /** Event hub the consumer group reads. Changing it replaces the consumer group. */
  eventHub: string;
  /**
   * Consumer group name: 1-50 letters, digits, periods, hyphens, and
   * underscores, starting and ending with a letter or digit. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the consumer group. The built-in `$Default` group is never
   * managed.
   */
  name?: string;
  /**
   * Free-form user metadata. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because consumer groups have no tags.
   */
  userMetadata?: string;
}

export interface ConsumerGroup extends Resource<
  "Azure.EventHub.ConsumerGroup",
  ConsumerGroupProps,
  {
    /** Name of the consumer group. */
    consumerGroupName: string;
    /** ARM resource ID of the consumer group. */
    consumerGroupId: string;
    /** Event hub the consumer group reads. */
    eventHub: string;
    /** Namespace of the event hub. */
    namespace: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** User metadata (Alchemy ownership marker stripped). */
    userMetadata: string | undefined;
    /** Time the consumer group was created. */
    createdAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A consumer group — an independent view (offsets and checkpoints) of an
 * event hub for one reading application.
 *
 * Consumer groups need a `Standard` (or higher) namespace: `Basic` only has
 * the built-in `$Default` group. Ownership is recorded as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of `userMetadata`.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/event-hubs-features#consumer-groups
 *
 * ### Creating a Consumer Group
 * **Example:** One consumer group per reading service
 * ```typescript
 * const orders = yield* Azure.EventHub.EventHub("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 * });
 * const billing = yield* Azure.EventHub.ConsumerGroup("billing", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   eventHub: orders.eventHubName,
 *   userMetadata: "billing service",
 * });
 * ```
 *
 * @resource
 */
export const ConsumerGroup = Resource<ConsumerGroup>(
  "Azure.EventHub.ConsumerGroup",
);

const getConsumerGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  eventHubName: string,
  consumerGroupName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetConsumerGroup({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      eventHubName,
      consumerGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  eventHub: string,
  name: string,
  group: eventhub.GetConsumerGroupResponse,
): ConsumerGroup["Attributes"] => ({
  consumerGroupName: name,
  consumerGroupId: group.id ?? "",
  eventHub,
  namespace,
  resourceGroup,
  userMetadata: stripMarker(group.properties?.userMetadata),
  createdAt: group.properties?.createdAt,
});

export const ConsumerGroupProvider = () =>
  Provider.succeed(ConsumerGroup, {
    stables: [
      "consumerGroupName",
      "consumerGroupId",
      "eventHub",
      "namespace",
      "resourceGroup",
    ],

    // Consumer groups live inside an event hub; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        news.eventHub.toLowerCase() !== output.eventHub.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.consumerGroupName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      const eventHub = output?.eventHub ?? olds?.eventHub;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its event hub.
      if (
        resourceGroup === undefined ||
        namespace === undefined ||
        eventHub === undefined
      ) {
        return undefined;
      }
      const name =
        output?.consumerGroupName ??
        olds?.name ??
        (yield* createEntityName(id, 50));
      const observed = yield* getConsumerGroup(
        subscriptionId,
        resourceGroup,
        namespace,
        eventHub,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, eventHub, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.userMetadata ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace, eventHub } = news;
      const name =
        news.name ??
        output?.consumerGroupName ??
        (yield* createEntityName(id, 50));
      const userMetadata = withMarker(
        news.userMetadata,
        yield* ownershipMarker(id),
      );
      const get = getConsumerGroup(
        subscriptionId,
        resourceGroup,
        namespace,
        eventHub,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the only mutable aspect is userMetadata, and the PUT
      // is a synchronous upsert.
      if (
        observed === undefined ||
        observed.properties?.userMetadata !== userMetadata
      ) {
        yield* eventhub.ConsumerGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          eventHubName: eventHub,
          consumerGroupName: name,
          properties: { userMetadata },
        });
      }

      const fresh = yield* waitForProvisioned(
        `consumer group ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, namespace, eventHub, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventhub.DeleteConsumerGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          eventHubName: output.eventHub,
          consumerGroupName: output.consumerGroupName,
        }),
      );
      yield* waitUntilGone(
        `consumer group ${output.consumerGroupName}`,
        getConsumerGroup(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.eventHub,
          output.consumerGroupName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.EventHub.EventHub",
        "Azure.EventHub.Namespace",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
