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

export interface ClientGroupProps {
  /** Resource group of the namespace. Changing it replaces the client group. */
  resourceGroup: string;
  /**
   * Name of the Event Grid namespace (MQTT broker enabled). Changing it
   * replaces the client group.
   */
  namespace: string;
  /**
   * Client group name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the client group.
   */
  name?: string;
  /**
   * Query over client attributes that selects the group's members, e.g.
   * `attributes.role IN ['sensor', 'gateway']`. Every namespace also has a
   * built-in `$all` group that contains every client.
   */
  query: string;
  /** Description of the client group. */
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
 * A group of MQTT clients in an Event Grid namespace, selected by a query
 * over client attributes. Permission bindings grant a client group publish
 * or subscribe access to a topic space.
 *
 * Client groups have no tags; Alchemy appends an ownership marker to the
 * `description`.
 *
 * @see https://learn.microsoft.com/azure/event-grid/mqtt-client-groups
 *
 * ### Grouping Clients
 * **Example:** All clients whose `role` attribute is `sensor`
 * ```typescript
 * const namespace = yield* Azure.EventGrid.Namespace("iot", {
 *   resourceGroup: group.resourceGroupName,
 *   topicSpacesConfiguration: { state: "Enabled" },
 * });
 * const sensors = yield* Azure.EventGrid.ClientGroup("sensors", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   query: "attributes.role = 'sensor'",
 * });
 * ```
 *
 * @resource
 */
export const ClientGroup = Resource<ClientGroup>("Azure.EventGrid.ClientGroup");

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
      const name =
        output?.clientGroupName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
      const observed = yield* getClientGroup(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
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
      const name =
        news.name ??
        output?.clientGroupName ??
        (yield* createEventGridName(id, 50));
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
          have.properties?.description !== description ||
          have.properties?.query !== news.query,
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
