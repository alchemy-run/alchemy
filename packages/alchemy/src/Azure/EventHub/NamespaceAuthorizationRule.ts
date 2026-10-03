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
  type AccessRight,
  type AuthorizationRuleKeys,
  createEntityName,
  namespaceOwnedByStage,
  sameRights,
  toKeys,
} from "./Common.ts";

export type { AccessRight, AuthorizationRuleKeys } from "./Common.ts";

export interface NamespaceAuthorizationRuleProps {
  /** Resource group of the namespace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Namespace the rule grants access to. Changing it replaces the rule. */
  namespace: string;
  /**
   * Rule name: letters, digits, periods, hyphens, and underscores. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the rule. The built-in `RootManageSharedAccessKey`
   * rule is never managed.
   */
  name?: string;
  /**
   * Rights granted to holders of the rule's keys. `Manage` requires `Send`
   * and `Listen` as well.
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
    /** Rights granted by the rule. */
    rights: string[];
  },
  never,
  Providers
> {}

/**
 * A shared access (SAS) policy on an Event Hubs namespace. Its keys and
 * connection strings grant the listed rights on every event hub in the
 * namespace.
 *
 * Authorization rules have no tags or metadata; Alchemy treats a rule as
 * owned when its namespace carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/authorize-access-shared-access-signature
 *
 * ### Creating a Rule
 * **Example:** Send-only policy for producers
 * ```typescript
 * const producers = yield* Azure.EventHub.NamespaceAuthorizationRule("producers", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   rights: ["Send"],
 * });
 * // producers.primaryConnectionString is Redacted
 * ```
 *
 * **Example:** Full management policy
 * ```typescript
 * const admin = yield* Azure.EventHub.NamespaceAuthorizationRule("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 *   rights: ["Manage", "Send", "Listen"],
 * });
 * ```
 *
 * @resource
 */
export const NamespaceAuthorizationRule = Resource<NamespaceAuthorizationRule>(
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
    stables: [
      "authorizationRuleName",
      "authorizationRuleId",
      "namespace",
      "resourceGroup",
    ],

    // Rules live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.namespace.toLowerCase() !== output.namespace.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.authorizationRuleName.toLowerCase())
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
        output?.authorizationRuleName ??
        olds?.name ??
        (yield* createEntityName(id, 256));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed, undefined);
      return (yield* namespaceOwnedByStage(
        subscriptionId,
        resourceGroup,
        namespace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const { resourceGroup, namespace } = news;
      const name =
        news.name ??
        output?.authorizationRuleName ??
        (yield* createEntityName(id, 256));
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
      if (
        observed === undefined ||
        !sameRights(observed.properties?.rights, news.rights)
      ) {
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
