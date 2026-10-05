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

/** Built-in hub rules Azure creates; Alchemy never deletes them. */
const BUILT_IN_RULES = [
  "DefaultListenSharedAccessSignature",
  "DefaultFullSharedAccessSignature",
];

export interface NotificationHubAuthorizationRuleProps {
  /** Resource group of the namespace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Namespace that holds the hub. Changing it replaces the rule. */
  namespace: string;
  /** Notification hub the rule grants access to. Changing it replaces the rule. */
  notificationHub: string;
  /**
   * Rule name: letters, digits, `.`, `-`, and `_`. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the rule.
   */
  name?: string;
  /**
   * Granted rights. `Listen` lets devices register; `Send` lets backends
   * push; `Manage` requires `Listen` and `Send` (added automatically).
   */
  rights: AccessRight[];
}

export interface NotificationHubAuthorizationRule extends Resource<
  "Azure.NotificationHubs.NotificationHubAuthorizationRule",
  NotificationHubAuthorizationRuleProps,
  {
    /** Name of the rule. */
    authorizationRuleName: string;
    /** ARM resource ID of the rule. */
    authorizationRuleId: string;
    /** Notification hub the rule grants access to. */
    notificationHubName: string;
    /** Namespace that holds the hub. */
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
 * A shared access (SAS) authorization rule on a single notification hub.
 * Mobile apps use a `Listen` rule to register devices; backends use a
 * `Send` rule to push. The rule's keys and connection strings are exposed
 * as secrets.
 *
 * Authorization rules have no tags: Alchemy treats a rule it did not create
 * as unowned and only takes it over with `--adopt`. The built-in
 * `DefaultListenSharedAccessSignature` and
 * `DefaultFullSharedAccessSignature` rules are never deleted.
 *
 * @see https://learn.microsoft.com/azure/notification-hubs/notification-hubs-push-notification-security
 *
 * ### Creating a Rule
 * **Example:** Listen rule for the mobile app
 * ```typescript
 * const hub = yield* Azure.NotificationHubs.NotificationHub("app", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 * });
 * const devices = yield* Azure.NotificationHubs.NotificationHubAuthorizationRule(
 *   "devices",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: ns.namespaceName,
 *     notificationHub: hub.notificationHubName,
 *     rights: ["Listen"],
 *   },
 * );
 * ```
 *
 * **Example:** Send rule for the backend
 * ```typescript
 * const backend = yield* Azure.NotificationHubs.NotificationHubAuthorizationRule(
 *   "backend",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: ns.namespaceName,
 *     notificationHub: hub.notificationHubName,
 *     rights: ["Send"],
 *   },
 * );
 * // backend.primaryConnectionString is a Redacted secret
 * ```
 *
 * @resource
 */
export const NotificationHubAuthorizationRule =
  Resource<NotificationHubAuthorizationRule>(
    "Azure.NotificationHubs.NotificationHubAuthorizationRule",
  );

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  notificationHubName: string;
  authorizationRuleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(
    notificationhubs.GetNotificationHubAuthorizationRule(where),
  );

const toAttrs = Effect.fn(function* (
  where: Where,
  rule: notificationhubs.GetNotificationHubAuthorizationRuleResponse,
) {
  const keys = yield* orUndefinedIfNotFound(
    notificationhubs.ListNotificationHubKeys(where),
  );
  return {
    authorizationRuleName: where.authorizationRuleName,
    authorizationRuleId: rule.id ?? "",
    notificationHubName: where.notificationHubName,
    namespaceName: where.namespaceName,
    resourceGroup: where.resourceGroupName,
    rights: normalizeRights(rule.properties?.rights ?? []),
    ...toSecrets(keys ?? {}),
  } satisfies NotificationHubAuthorizationRule["Attributes"];
});

export const NotificationHubAuthorizationRuleProvider = () =>
  Provider.succeed(NotificationHubAuthorizationRule, {
    stables: [
      "authorizationRuleName",
      "authorizationRuleId",
      "notificationHubName",
      "namespaceName",
      "resourceGroup",
    ],

    // Rules live inside a hub; nuke removes them with the namespace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        !sameName(news.notificationHub, output.notificationHubName) ||
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
      const notificationHubName =
        output?.notificationHubName ?? olds?.notificationHub;
      if (
        resourceGroupName === undefined ||
        namespaceName === undefined ||
        notificationHubName === undefined
      ) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        notificationHubName,
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
        notificationHubName: news.notificationHub,
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
        yield* notificationhubs.NotificationHubsCreateOrUpdateAuthorizationRule(
          { ...where, properties: { rights } },
        );
      }

      const fresh = yield* waitForProvisioned(
        `notification hub rule ${where.authorizationRuleName}`,
        getRule(where),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return yield* toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        BUILT_IN_RULES.some((rule) =>
          sameName(rule, output.authorizationRuleName),
        )
      ) {
        return;
      }
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
        notificationHubName: output.notificationHubName,
        authorizationRuleName: output.authorizationRuleName,
      };
      yield* ignoreNotFound(
        notificationhubs.DeleteNotificationHubAuthorizationRule(where),
      );
      yield* waitUntilGone(
        `notification hub rule ${output.authorizationRuleName}`,
        getRule(where),
      );
    }),

    nuke: { dependsOn: ["Azure.NotificationHubs.NotificationHub"] },
  });
