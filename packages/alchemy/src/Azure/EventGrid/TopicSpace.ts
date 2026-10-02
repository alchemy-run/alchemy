import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEventGridName, sameName } from "./common.ts";
import {
  isOwnedDescription,
  markedDescription,
  reconcileChild,
  userDescription,
} from "./MqttShared.ts";

export interface TopicSpaceProps {
  /** Resource group of the namespace. Changing it replaces the topic space. */
  resourceGroup: string;
  /**
   * Name of the Event Grid namespace (MQTT broker enabled). Changing it
   * replaces the topic space.
   */
  namespace: string;
  /**
   * Topic space name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the topic space.
   */
  name?: string;
  /**
   * MQTT topic templates in the space, e.g. `devices/+/telemetry` or
   * `devices/${client.authenticationName}/telemetry`.
   */
  topicTemplates: string[];
  /** Description of the topic space. */
  description?: string;
}

export interface TopicSpace extends Resource<
  "Azure.EventGrid.TopicSpace",
  TopicSpaceProps,
  {
    /** Name of the topic space. */
    topicSpaceName: string;
    /** ARM resource ID of the topic space. */
    topicSpaceId: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Name of the namespace. */
    namespace: string;
    /** MQTT topic templates. */
    topicTemplates: string[];
    /**
     * Description. Azure does not return it on GET, so this is the desired
     * description after a deploy.
     */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A set of MQTT topic templates in an Event Grid namespace. Permission
 * bindings grant client groups publish or subscribe access to a topic
 * space.
 *
 * Topic spaces have no tags and Azure does not return their `description`
 * on GET, so ownership follows the parent namespace.
 *
 * @see https://learn.microsoft.com/azure/event-grid/mqtt-topic-spaces
 *
 * ### Defining Topic Spaces
 * **Example:** Per-device telemetry topics
 * ```typescript
 * const namespace = yield* Azure.EventGrid.Namespace("iot", {
 *   resourceGroup: group.resourceGroupName,
 *   topicSpacesConfiguration: { state: "Enabled" },
 * });
 * const telemetry = yield* Azure.EventGrid.TopicSpace("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   topicTemplates: ["devices/${client.authenticationName}/telemetry"],
 * });
 * ```
 *
 * @resource
 */
export const TopicSpace = Resource<TopicSpace>("Azure.EventGrid.TopicSpace");

type ObservedTopicSpace = Pick<eventgrid.TopicSpace, "id" | "properties">;

const getTopicSpace = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  topicSpaceName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetTopicSpace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicSpaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  observed: ObservedTopicSpace,
): TopicSpace["Attributes"] => ({
  topicSpaceName: name,
  topicSpaceId: observed.id ?? "",
  resourceGroup,
  namespace,
  topicTemplates: [...(observed.properties?.topicTemplates ?? [])],
  description: userDescription(observed.properties?.description),
});

const sorted = (values: readonly string[] | undefined) =>
  JSON.stringify([...(values ?? [])].sort());

export const TopicSpaceProvider = () =>
  Provider.succeed(TopicSpace, {
    stables: ["topicSpaceName", "topicSpaceId", "resourceGroup", "namespace"],

    // Deleted with their namespace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespace) ||
        (news.name !== undefined && news.name !== output.topicSpaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const name =
        output?.topicSpaceName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
      const observed = yield* getTopicSpace(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      // GET returns `description: null` for this type, so the marker cannot
      // be observed; ownership then follows the parent namespace.
      const description = observed.properties?.description;
      return description == null || (yield* isOwnedDescription(id, description))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, namespace } = news;
      const name =
        news.name ??
        output?.topicSpaceName ??
        (yield* createEventGridName(id, 50));
      const description = yield* markedDescription(id, news.description);
      const observed = yield* reconcileChild({
        label: `event grid topic space ${name}`,
        get: getTopicSpace(subscriptionId, resourceGroup, namespace, name),
        put: eventgrid.TopicSpacesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          topicSpaceName: name,
          properties: { description, topicTemplates: news.topicTemplates },
        }),
        // GET returns `description: null`; when it cannot be observed, the
        // previous props are the only hint that it changed.
        differs: (have) =>
          (have.properties?.description == null
            ? olds === undefined || olds.description !== news.description
            : have.properties.description !== description) ||
          sorted(have.properties?.topicTemplates) !==
            sorted(news.topicTemplates),
      });
      return {
        ...toAttrs(resourceGroup, namespace, name, observed),
        description:
          userDescription(observed.properties?.description) ?? news.description,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteTopicSpace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          topicSpaceName: output.topicSpaceName,
        }),
      );
      yield* waitUntilGone(
        `event grid topic space ${output.topicSpaceName}`,
        getTopicSpace(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.topicSpaceName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Namespace"] },
  });
