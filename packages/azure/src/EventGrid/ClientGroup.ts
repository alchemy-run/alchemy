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

export interface ClientGroupProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the client group.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the Event Grid namespace, e.g. `namespace.namespaceName` of an
   * `Azure.EventGrid.Namespace` with the MQTT broker enabled.
   *
   * :::caution
   * Changing it replaces the client group.
   * :::
   */
  namespace: string;
  /**
   * Client group name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the client group.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Query over client attributes that selects the group's members, e.g.
   * `attributes.role IN ['sensor', 'gateway']`. Every namespace also has a
   * built-in `$all` group that contains every client. Updated in place.
   */
  query: string;
  /**
   * Description of the client group. Alchemy appends its ownership marker
   * (` [alchemy:{stack}/{stage}/{id}]`) to it.
   * @default no description (only the ownership marker)
   */
  description?: string;
}

export interface ClientGroup extends Resource<
  "Azure.EventGrid.ClientGroup",
  ClientGroupProps,
  {
    /** Name of the client group. */
    clientGroupName: string;
    /** ARM resource ID of the client group. */
    clientGroupId: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Name of the namespace. */
    namespace: string;
    /** Membership query. */
    query: string | undefined;
    /** Description (Alchemy ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An MQTT client group of an Event Grid MQTT broker
 * (`Microsoft.EventGrid/namespaces/clientGroups`): the clients that match a
 * query over client attributes. Grant a client group publish or subscribe
 * access to a topic space with an `Azure.EventGrid.PermissionBinding`.
 *
 * Client groups have no tags; Alchemy appends an ownership marker to the
 * `description`.
 *
 * :::caution[Changing `name`, `namespace`, or `resourceGroup` replaces the client group]
 * Alchemy creates a new client group and deletes the old one.
 * :::
 *
 * :::caution[The namespace needs the MQTT broker]
 * Declare the parent `Azure.EventGrid.Namespace` with
 * `topicSpacesConfiguration: { state: "Enabled" }`. Azure cannot turn the
 * broker off again: switching it to `Disabled` replaces the namespace.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/mqtt-client-groups
 *
 * ### Grouping Clients
 * **Example:** All clients whose `role` attribute is `sensor`
 * ```typescript
 * const namespace = yield* Azure.EventGrid.Namespace("iot", {
 *   topicSpacesConfiguration: { state: "Enabled" },
 * });
 * const sensors = yield* Azure.EventGrid.ClientGroup("sensors", {
 *   namespace: namespace.namespaceName,
 *   query: "attributes.role = 'sensor'",
 * });
 * ```
 *
 * **Example:** Clients with one of several roles
 * ```typescript
 * const fleet = yield* Azure.EventGrid.ClientGroup("fleet", {
 *   namespace: namespace.namespaceName,
 *   query: "attributes.role IN ['sensor', 'gateway']",
 *   description: "Sensors and gateways",
 * });
 * ```
 *
 * @resource
 */
export const ClientGroup = GroupedResource<ClientGroup>("Azure.EventGrid.ClientGroup");

type ObservedClientGroup = Pick<eventgrid.ClientGroup, "id" | "properties">;

const getClientGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  clientGroupName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetClientGroup({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      clientGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  observed: ObservedClientGroup,
): ClientGroup["Attributes"] => ({
  clientGroupName: name,
  clientGroupId: observed.id ?? "",
  resourceGroup,
  namespace,
  query: observed.properties?.query,
  description: userDescription(observed.properties?.description),
});

export const ClientGroupProvider = () =>
  Provider.succeed(ClientGroup, {
    stables: ["clientGroupName", "clientGroupId", "resourceGroup", "namespace"],

    // Deleted with their namespace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespace) ||
        (news.name !== undefined && news.name !== output.clientGroupName)
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
      const name = output?.clientGroupName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getClientGroup(subscriptionId, resourceGroup, namespace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      return (yield* isOwnedDescription(id, observed.properties?.description))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, namespace } = news;
      const name = news.name ?? output?.clientGroupName ?? (yield* createEventGridName(id, 50));
      const description = yield* markedDescription(id, news.description);
      const observed = yield* reconcileChild({
        label: `event grid client group ${name}`,
        get: getClientGroup(subscriptionId, resourceGroup, namespace, name),
        put: eventgrid.ClientGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          clientGroupName: name,
          properties: { description, query: news.query },
        }),
        differs: (have) =>
          have.properties?.description !== description || have.properties?.query !== news.query,
      });
      return toAttrs(resourceGroup, namespace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteClientGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          clientGroupName: output.clientGroupName,
        }),
      );
      yield* waitUntilGone(
        `event grid client group ${output.clientGroupName}`,
        getClientGroup(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.clientGroupName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Namespace"] },
  });
