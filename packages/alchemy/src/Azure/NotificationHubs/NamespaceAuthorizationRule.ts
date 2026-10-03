import * as notificationhubs from "@distilled.cloud/azure/notificationhubs";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  createEntityName,
  normalizeRights,
  rightsEqual,
  sameName,
  toSecrets,
} from "./internal.ts";

export type { AccessRight as NotificationHubsAccessRight };

/** Built-in namespace rule Azure creates; Alchemy never deletes it. */
const ROOT_MANAGE_RULE = "RootManageSharedAccessKey";

export interface NamespaceAuthorizationRuleProps {
  /** Resource group of the namespace. Changing it replaces the rule. */
  resourceGroup: string;
  /**
   * Notification Hubs namespace the rule grants access to. Changing it
   * replaces the rule.
   */
  namespace: string;
  /**
   * Rule name: letters, digits, `.`, `-`, and `_`. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the rule.
   */
  name?: string;
  /**
   * Granted rights. `Manage` requires `Listen` and `Send`; Alchemy adds them
   * automatically.
   */
  rights: AccessRight[];
}

export interface NamespaceAuthorizationRule extends Resource<
  "Azure.NotificationHubs.NamespaceAuthorizationRule",
  NamespaceAuthorizationRuleProps,
  {
    /** Name of the rule. */
    authorizationRuleName: string;
    /** ARM resource ID of the rule. */
    authorizationRuleId: string;
    /** Namespace the rule grants access to. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Granted rights (sorted; `Manage` implies `Listen` and `Send`). */
    rights: AccessRight[];
    /** Primary SAS key. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** Primary connection string (`Endpoint=sb://...;SharedAccessKeyName=...`). */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Secondary connection string. */
    secondaryConnectionString: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A shared access (SAS) authorization rule on an Azure Notification Hubs
 * namespace. It grants `Listen`, `Send`, and/or `Manage` on every hub in the
 * namespace and exposes the rule's keys and connection strings as secrets.
 *
 * Authorization rules have no tags: Alchemy treats a rule it did not create
 * (e.g. an existing rule with the same explicit `name`) as unowned and only
 * takes it over with `--adopt`. The built-in `RootManageSharedAccessKey` rule
 * is never deleted.
 *
 * @see https://learn.microsoft.com/azure/notification-hubs/notification-hubs-push-notification-security
 *
 * ### Creating a Rule
 * **Example:** Send-only rule for a backend
 * ```typescript
 * const ns = yield* Azure.NotificationHubs.Namespace("push", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const backend = yield* Azure.NotificationHubs.NamespaceAuthorizationRule(
 *   "backend",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: ns.namespaceName,
 *     rights: ["Send"],
 *   },
 * );
 * // backend.primaryConnectionString is a Redacted secret
 * ```
 *
 * **Example:** Manage rule (implies Listen and Send)
 * ```typescript
 * const admin = yield* Azure.NotificationHubs.NamespaceAuthorizationRule(
 *   "admin",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: ns.namespaceName,
 *     rights: ["Manage"],
 *   },
 * );
 * ```
 *
 * @resource
 */
export const NamespaceAuthorizationRule = Resource<NamespaceAuthorizationRule>(
  "Azure.NotificationHubs.NamespaceAuthorizationRule",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  authorizationRuleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(notificationhubs.GetNamespaceAuthorizationRule(where));

const toAttrs = Effect.fn(function* (
  where: Where,
  rule: notificationhubs.GetNamespaceAuthorizationRuleResponse,
) {
  const keys = yield* orUndefinedIfNotFound(
    notificationhubs.ListNamespaceKeys(where),
  );
  return {
    authorizationRuleName: where.authorizationRuleName,
    authorizationRuleId: rule.id ?? "",
    namespaceName: where.namespaceName,
    resourceGroup: where.resourceGroupName,
    rights: normalizeRights(rule.properties?.rights ?? []),
    ...toSecrets(keys ?? {}),
  } satisfies NamespaceAuthorizationRule["Attributes"];
});

export const NamespaceAuthorizationRuleProvider = () =>
  Provider.succeed(NamespaceAuthorizationRule, {
    stables: [
      "authorizationRuleName",
      "authorizationRuleId",
      "namespaceName",
      "resourceGroup",
    ],

    // Rules live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined &&
          !sameName(news.name, output.authorizationRuleName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      if (resourceGroupName === undefined || namespaceName === undefined) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        authorizationRuleName:
          output?.authorizationRuleName ??
          olds?.name ??
          (yield* createEntityName(id, 64)),
      };
      const observed = yield* getRule(where);
      if (observed === undefined) return undefined;
      const attrs = yield* toAttrs(where, observed);
      // No tags: only a rule we already track is provably ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NotificationHubs");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        namespaceName: news.namespace,
        authorizationRuleName:
          news.name ??
          output?.authorizationRuleName ??
          (yield* createEntityName(id, 64)),
      };
      const rights = normalizeRights(news.rights);

      // Observe.
      const observed = yield* getRule(where);

      // Ensure + sync rights.
      if (
        observed === undefined ||
        !rightsEqual(observed.properties?.rights, rights)
      ) {
        yield* notificationhubs.NamespacesCreateOrUpdateAuthorizationRule({
          ...where,
          properties: { rights },
        });
      }

      const fresh = yield* waitForProvisioned(
        `notification hubs namespace rule ${where.authorizationRuleName}`,
        getRule(where),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return yield* toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (sameName(output.authorizationRuleName, ROOT_MANAGE_RULE)) return;
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
        authorizationRuleName: output.authorizationRuleName,
      };
      yield* ignoreNotFound(
        notificationhubs.DeleteNamespaceAuthorizationRule(where),
      );
      yield* waitUntilGone(
        `notification hubs namespace rule ${output.authorizationRuleName}`,
        getRule(where),
      );
    }),

    nuke: { dependsOn: ["Azure.NotificationHubs.Namespace"] },
  });
