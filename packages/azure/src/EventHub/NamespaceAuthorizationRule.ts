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

export type { AccessRight, AuthorizationRuleKeys } from "./Common.ts";

export interface NamespaceAuthorizationRuleProps {
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
   * Name of the namespace the rule grants access to, e.g.
   * `namespace.namespaceName`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  namespace: string;
  /**
   * Rule name, up to 256 characters: letters, digits, periods, hyphens, and
   * underscores, starting and ending with a letter or digit. Do not use the
   * built-in `RootManageSharedAccessKey` rule's name.
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

export interface NamespaceAuthorizationRule extends Resource<
  "Azure.EventHub.NamespaceAuthorizationRule",
  NamespaceAuthorizationRuleProps,
  AuthorizationRuleKeys & {
    /** Name of the rule. */
    authorizationRuleName: string;
    /** ARM resource ID of the rule. */
    authorizationRuleId: string;
    /** Namespace the rule grants access to. */
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
 * A shared access (SAS) policy on an Event Hubs namespace
 * (`Microsoft.EventHub/namespaces/authorizationRules`). Its keys and
 * connection strings grant the listed rights on every event hub in the
 * namespace. Use it for a client that cannot use Microsoft Entra ID;
 * Alchemy's bindings use Entra ID roles instead.
 *
 * Authorization rules have no tags or metadata. Alchemy treats a rule as
 * owned when its namespace carries this stack's ownership tags.
 *
 * :::caution[Changing `name`, `namespace`, or `resourceGroup` replaces the rule]
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
 * **Example:** Send-only policy for producers
 * ```typescript
 * const namespace = yield* Azure.EventHub.Namespace("events");
 * const producers = yield* Azure.EventHub.NamespaceAuthorizationRule("producers", {
 *   namespace: namespace.namespaceName,
 *   rights: ["Send"],
 * });
 * // producers.primaryConnectionString is Redacted
 * ```
 *
 * **Example:** Full management policy
 * ```typescript
 * const admin = yield* Azure.EventHub.NamespaceAuthorizationRule("admin", {
 *   namespace: namespace.namespaceName,
 *   rights: ["Manage", "Send", "Listen"],
 * });
 * ```
 *
 * @resource
 */
export const NamespaceAuthorizationRule = GroupedResource<NamespaceAuthorizationRule>(
  "Azure.EventHub.NamespaceAuthorizationRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  authorizationRuleName: string,
) =>
  orUndefinedIfNotFound(
    eventhub.GetNamespaceAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      authorizationRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  name: string,
  rule: eventhub.GetNamespaceAuthorizationRuleResponse,
  keys: eventhub.AccessKeys | undefined,
): NamespaceAuthorizationRule["Attributes"] => ({
  authorizationRuleName: name,
  authorizationRuleId: rule.id ?? "",
  namespace,
  resourceGroup,
  rights: [...(rule.properties?.rights ?? [])],
  ...toKeys(keys ?? {}),
});

export const NamespaceAuthorizationRuleProvider = () =>
  Provider.succeed(NamespaceAuthorizationRule, {
    stables: ["authorizationRuleName", "authorizationRuleId", "namespace", "resourceGroup"],

    // Rules live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
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
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its namespace.
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const name =
        output?.authorizationRuleName ?? olds?.name ?? (yield* createEntityName(id, 256));
      const observed = yield* getRule(subscriptionId, resourceGroup, namespace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed, undefined);
      return (yield* namespaceOwnedByStage(subscriptionId, resourceGroup, namespace))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace } = news;
      const name = news.name ?? output?.authorizationRuleName ?? (yield* createEntityName(id, 256));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: namespace,
        authorizationRuleName: name,
      };
      const get = getRule(subscriptionId, resourceGroup, namespace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync rights; the PUT is a synchronous upsert.
      if (observed === undefined || !sameRights(observed.properties?.rights, news.rights)) {
        yield* eventhub.NamespacesCreateOrUpdateAuthorizationRule({
          ...where,
          properties: { rights: news.rights },
        });
      }

      const fresh = yield* waitForProvisioned(
        `namespace authorization rule ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      const keys = yield* eventhub.ListNamespaceKeys(where);
      return toAttrs(resourceGroup, namespace, name, fresh, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventhub.DeleteNamespaceAuthorizationRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          authorizationRuleName: output.authorizationRuleName,
        }),
      );
      yield* waitUntilGone(
        `namespace authorization rule ${output.authorizationRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.authorizationRuleName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.EventHub.Namespace", "Azure.Resources.ResourceGroup"],
    },
  });
