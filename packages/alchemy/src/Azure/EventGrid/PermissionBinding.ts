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

export interface PermissionBindingProps {
  /** Resource group of the namespace. Changing it replaces the permission binding. */
  resourceGroup: string;
  /**
   * Name of the Event Grid namespace (MQTT broker enabled). Changing it
   * replaces the permission binding.
   */
  namespace: string;
  /**
   * Topic space name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the permission binding.
   */
  name?: string;
  /** Name of the topic space the permission applies to (same namespace). */
  topicSpace: string;
  /** Name of the client group granted the permission (same namespace). */
  clientGroup: string;
  /** Whether the client group may publish to or subscribe to the topic space. */
  permission: "Publisher" | "Subscriber";
  /** Description of the permission binding. */
  description?: string;
}

export interface PermissionBinding extends Resource<
  "Azure.EventGrid.PermissionBinding",
  PermissionBindingProps,
  {
    /** Name of the permission binding. */
    permissionBindingName: string;
    /** ARM resource ID of the permission binding. */
    permissionBindingId: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Name of the namespace. */
    namespace: string;
    /** Name of the topic space. */
    topicSpace: string | undefined;
    /** Name of the client group. */
    clientGroup: string | undefined;
    /** Granted permission. */
    permission: "Publisher" | "Subscriber" | undefined;
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
 * Grants an MQTT client group publish or subscribe access to a topic space
 * in an Event Grid namespace.
 *
 * Permission bindings have no tags and Azure does not return their
 * `description` on GET, so ownership follows the parent namespace.
 *
 * @see https://learn.microsoft.com/azure/event-grid/mqtt-access-control
 *
 * ### Granting Access
 * **Example:** Sensors may publish telemetry
 * ```typescript
 * const telemetry = yield* Azure.EventGrid.TopicSpace("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   topicTemplates: ["devices/${client.authenticationName}/telemetry"],
 * });
 * const sensors = yield* Azure.EventGrid.ClientGroup("sensors", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   query: "attributes.role = 'sensor'",
 * });
 * const publish = yield* Azure.EventGrid.PermissionBinding("sensors-publish", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   topicSpace: telemetry.topicSpaceName,
 *   clientGroup: sensors.clientGroupName,
 *   permission: "Publisher",
 * });
 * ```
 *
 * @resource
 */
export const PermissionBinding = Resource<PermissionBinding>(
  "Azure.EventGrid.PermissionBinding",
);

type ObservedPermissionBinding = Pick<
  eventgrid.PermissionBinding,
  "id" | "properties"
>;

const getPermissionBinding = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  permissionBindingName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetPermissionBinding({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      permissionBindingName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  observed: ObservedPermissionBinding,
): PermissionBinding["Attributes"] => ({
  permissionBindingName: name,
  permissionBindingId: observed.id ?? "",
  resourceGroup,
  namespace,
  topicSpace: observed.properties?.topicSpaceName,
  clientGroup: observed.properties?.clientGroupName,
  permission: observed.properties?.permission,
  description: userDescription(observed.properties?.description),
});

export const PermissionBindingProvider = () =>
  Provider.succeed(PermissionBinding, {
    stables: [
      "permissionBindingName",
      "permissionBindingId",
      "resourceGroup",
      "namespace",
    ],

    // Deleted with their namespace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespace) ||
        (news.name !== undefined && news.name !== output.permissionBindingName)
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
        output?.permissionBindingName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
      const observed = yield* getPermissionBinding(
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
        output?.permissionBindingName ??
        (yield* createEventGridName(id, 50));
      const description = yield* markedDescription(id, news.description);
      const observed = yield* reconcileChild({
        label: `event grid permission binding ${name}`,
        get: getPermissionBinding(
          subscriptionId,
          resourceGroup,
          namespace,
          name,
        ),
        put: eventgrid.PermissionBindingsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          permissionBindingName: name,
          properties: {
            description,
            topicSpaceName: news.topicSpace,
            clientGroupName: news.clientGroup,
            permission: news.permission,
          },
        }),
        // GET returns `description: null`; when it cannot be observed, the
        // previous props are the only hint that it changed.
        differs: (have) =>
          (have.properties?.description == null
            ? olds === undefined || olds.description !== news.description
            : have.properties.description !== description) ||
          !sameName(have.properties?.topicSpaceName, news.topicSpace) ||
          !sameName(have.properties?.clientGroupName, news.clientGroup) ||
          have.properties?.permission !== news.permission,
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
        eventgrid.DeletePermissionBinding({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          permissionBindingName: output.permissionBindingName,
        }),
      );
      yield* waitUntilGone(
        `event grid permission binding ${output.permissionBindingName}`,
        getPermissionBinding(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.permissionBindingName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Namespace"] },
  });
