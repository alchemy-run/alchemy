import * as eventhub from "@distilled.cloud/azure/eventhub";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  type AccessRight,
  type AuthorizationRuleKeys,
  createEntityName,
  namespaceOwnedByStage,
  sameRights,
  toKeys,
} from "./Common.ts";

export interface EventHubAuthorizationRuleProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the namespace that holds the event hub, e.g.
   * `namespace.namespaceName`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  namespace: string;
  /**
   * Name of the event hub the rule grants access to, e.g.
   * `orders.eventHubName`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  eventHub: string;
  /**
   * Rule name, up to 256 characters: letters, digits, periods, hyphens, and
   * underscores, starting and ending with a letter or digit.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Rights granted to holders of the rule's keys: `Send`, `Listen`, and/or
   * `Manage`. `Manage` requires `Send` and `Listen` as well. Changes apply
   * in place and keep the keys.
   */
  rights: AccessRight[];
}

export interface EventHubAuthorizationRule extends Resource<
  "Azure.EventHub.EventHubAuthorizationRule",
  EventHubAuthorizationRuleProps,
  AuthorizationRuleKeys & {
    /** Name of the rule. */
    authorizationRuleName: string;
    /** ARM resource ID of the rule. */
    authorizationRuleId: string;
    /** Event hub the rule grants access to. */
    eventHub: string;
    /** Namespace of the event hub. */
    namespace: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Rights granted by the rule (`Send`, `Listen`, `Manage`). */
    rights: string[];
  },
  never,
  Providers
> {}

/**
 * A shared access (SAS) policy on one event hub
 * (`Microsoft.EventHub/namespaces/eventhubs/authorizationRules`). Its keys
 * grant the listed rights on that hub only, and its connection strings
 * include `EntityPath`, so clients connect straight to it. Use it for a
 * client that cannot use Microsoft Entra ID; Alchemy's bindings use Entra
 * ID roles instead.
 *
 * Authorization rules have no tags or metadata. Alchemy treats a rule as
 * owned when its namespace carries this stack's ownership tags.
 *
 * :::caution[Changing `name`, `eventHub`, `namespace`, or `resourceGroup` replaces the rule]
 * Alchemy creates a new rule with new keys and deletes the old one. Clients
 * that hold the old connection string stop working.
 * :::
 *
 * :::caution[SAS keys stop working when local auth is off]
 * A namespace with `disableLocalAuth: true` rejects every SAS key, so the
 * rule's connection strings do not work there.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-hubs/authorize-access-shared-access-signature
 *
 * ### Creating a Rule
 * **Example:** Listen-only policy for one event hub
 * ```typescript
 * const namespace = yield* Azure.EventHub.Namespace("events");
 * const orders = yield* Azure.EventHub.EventHub("orders", {
 *   namespace: namespace.namespaceName,
 * });
 * const readers = yield* Azure.EventHub.EventHubAuthorizationRule("readers", {
 *   namespace: namespace.namespaceName,
 *   eventHub: orders.eventHubName,
 *   rights: ["Listen"],
 * });
 * // readers.primaryConnectionString is Redacted
 * ```
 *
 * @resource
 */
export const EventHubAuthorizationRule = GroupedResource<EventHubAuthorizationRule>(
  "Azure.EventHub.EventHubAuthorizationRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  eventHubName: string,
  authorizationRuleName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetEventHubAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      eventHubName,
      authorizationRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  eventHub: string,
  name: string,
  rule: eventhub.GetEventHubAuthorizationRuleResponse,
  keys: eventhub.AccessKeys | undefined,
): EventHubAuthorizationRule["Attributes"] => ({
  authorizationRuleName: name,
  authorizationRuleId: rule.id ?? "",
  eventHub,
  namespace,
  resourceGroup,
  rights: [...(rule.properties?.rights ?? [])],
  ...toKeys(keys ?? {}),
});

export const EventHubAuthorizationRuleProvider = () =>
  Provider.succeed(EventHubAuthorizationRule, {
    stables: [
      "authorizationRuleName",
      "authorizationRuleId",
      "eventHub",
      "namespace",
      "resourceGroup",
    ],

    // Rules live inside an event hub; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        news.eventHub.toLowerCase() !== output.eventHub.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.authorizationRuleName.toLowerCase())
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
      if (resourceGroup === undefined || namespace === undefined || eventHub === undefined) {
        return undefined;
      }
      const name =
        output?.authorizationRuleName ?? olds?.name ?? (yield* createEntityName(id, 256));
      const observed = yield* getRule(subscriptionId, resourceGroup, namespace, eventHub, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, eventHub, name, observed, undefined);
      return (yield* namespaceOwnedByStage(subscriptionId, resourceGroup, namespace))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace, eventHub } = news;
      const name = news.name ?? output?.authorizationRuleName ?? (yield* createEntityName(id, 256));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: namespace,
        eventHubName: eventHub,
        authorizationRuleName: name,
      };
      const get = getRule(subscriptionId, resourceGroup, namespace, eventHub, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync rights; the PUT is a synchronous upsert.
      if (observed === undefined || !sameRights(observed.properties?.rights, news.rights)) {
        yield* eventhub.EventHubsCreateOrUpdateAuthorizationRule({
          ...where,
          properties: { rights: news.rights },
        });
      }

      const fresh = yield* waitForProvisioned(
        `event hub authorization rule ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      const keys = yield* eventhub.ListEventHubKeys(where);
      return toAttrs(resourceGroup, namespace, eventHub, name, fresh, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventhub.DeleteEventHubAuthorizationRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          eventHubName: output.eventHub,
          authorizationRuleName: output.authorizationRuleName,
        }),
      );
      yield* waitUntilGone(
        `event hub authorization rule ${output.authorizationRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.eventHub,
          output.authorizationRuleName,
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
