import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createEventGridName, sameName } from "./common.ts";
import {
  isOwnedDescription,
  markedDescription,
  reconcileChild,
  userDescription,
} from "./MqttShared.ts";

export interface PermissionBindingProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the permission binding.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the Event Grid namespace, e.g. `namespace.namespaceName` of an
   * `Azure.EventGrid.Namespace` with the MQTT broker enabled.
   *
   * :::caution
   * Changing it replaces the permission binding.
   * :::
   */
  namespace: string;
  /**
   * Permission binding name: 3-50 letters, digits, and hyphens. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the permission binding.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Name of the topic space the permission applies to (same namespace),
   * e.g. `topicSpace.topicSpaceName`. Updated in place.
   */
  topicSpace: string;
  /**
   * Name of the client group granted the permission (same namespace), e.g.
   * `clientGroup.clientGroupName`, or `$all` for every client. Updated in
   * place.
   */
  clientGroup: string;
  /**
   * `Publisher` lets the client group publish to the topic space;
   * `Subscriber` lets it subscribe. Updated in place.
   */
  permission: "Publisher" | "Subscriber";
  /**
   * Description of the permission binding. Alchemy appends its ownership
   * marker (` [alchemy:{stack}/{stage}/{id}]`) to it.
   * @default no description (only the ownership marker)
   */
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
    /** Granted permission (`Publisher` or `Subscriber`). */
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
 * An MQTT permission binding of an Event Grid MQTT broker
 * (`Microsoft.EventGrid/namespaces/permissionBindings`): it grants one
 * client group publish or subscribe access to one topic space. Clients
 * have no access to any topic until a permission binding grants it.
 *
 * Permission bindings have no tags and Azure does not return their
 * `description` on GET, so ownership follows the parent namespace.
 *
 * :::caution[Changing `name`, `namespace`, or `resourceGroup` replaces the permission binding]
 * Alchemy creates a new binding and deletes the old one. `topicSpace`,
 * `clientGroup`, and `permission` update in place.
 * :::
 *
 * :::caution[The namespace needs the MQTT broker]
 * Declare the parent `Azure.EventGrid.Namespace` with
 * `topicSpacesConfiguration: { state: "Enabled" }`. Azure cannot turn the
 * broker off again: switching it to `Disabled` replaces the namespace.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/mqtt-access-control
 *
 * ### Granting Access
 * **Example:** Sensors may publish telemetry
 * ```typescript
 * const namespace = yield* Azure.EventGrid.Namespace("iot", {
 *   topicSpacesConfiguration: { state: "Enabled" },
 * });
 * const telemetry = yield* Azure.EventGrid.TopicSpace("telemetry", {
 *   namespace: namespace.namespaceName,
 *   topicTemplates: ["devices/${client.authenticationName}/telemetry"],
 * });
 * const sensors = yield* Azure.EventGrid.ClientGroup("sensors", {
 *   namespace: namespace.namespaceName,
 *   query: "attributes.role = 'sensor'",
 * });
 * const publish = yield* Azure.EventGrid.PermissionBinding("sensors-publish", {
 *   namespace: namespace.namespaceName,
 *   topicSpace: telemetry.topicSpaceName,
 *   clientGroup: sensors.clientGroupName,
 *   permission: "Publisher",
 * });
 * ```
 *
 * **Example:** Every client may subscribe to commands
 * ```typescript
 * const commands = yield* Azure.EventGrid.TopicSpace("commands", {
 *   namespace: namespace.namespaceName,
 *   topicTemplates: ["devices/+/commands"],
 * });
 * const subscribe = yield* Azure.EventGrid.PermissionBinding("all-subscribe", {
 *   namespace: namespace.namespaceName,
 *   topicSpace: commands.topicSpaceName,
 *   clientGroup: "$all",
 *   permission: "Subscriber",
 * });
 * ```
 *
 * @resource
 */
export const PermissionBinding = GroupedResource<PermissionBinding>(
  "Azure.EventGrid.PermissionBinding",
);

type ObservedPermissionBinding = Pick<eventgrid.PermissionBinding, "id" | "properties">;

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
    stables: ["permissionBindingName", "permissionBindingId", "resourceGroup", "namespace"],

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
        output?.permissionBindingName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getPermissionBinding(subscriptionId, resourceGroup, namespace, name);
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
        news.name ?? output?.permissionBindingName ?? (yield* createEventGridName(id, 50));
      const description = yield* markedDescription(id, news.description);
      const observed = yield* reconcileChild({
        label: `event grid permission binding ${name}`,
        get: getPermissionBinding(subscriptionId, resourceGroup, namespace, name),
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
        description: userDescription(observed.properties?.description) ?? news.description,
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
