import * as servicebus from "@distilled.cloud/azure/servicebus";
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

export type { AccessRight };

/** Built-in namespace rule Azure creates; Alchemy never deletes it. */
export const ROOT_MANAGE_RULE = "RootManageSharedAccessKey";

export interface NamespaceAuthorizationRuleProps {
  /** Resource group of the namespace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Namespace the rule grants access to. Changing it replaces the rule. */
  namespace: string;
  /**
   * Rule name: 1-50 letters, digits, `.`, `-`, and `_`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the rule.
   */
  name?: string;
  /**
   * Granted rights. `Manage` implies `Listen` and `Send`; Alchemy adds them
   * automatically.
   */
  rights: AccessRight[];
}

export interface NamespaceAuthorizationRule extends Resource<
  "Azure.ServiceBus.NamespaceAuthorizationRule",
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
 * A shared access (SAS) authorization rule on a Service Bus namespace. It
 * grants `Listen`, `Send`, and/or `Manage` on every entity in the namespace
 * and exposes the rule's keys and connection strings as secrets.
 *
 * Authorization rules have no tags or metadata: Alchemy treats a rule it
 * did not create (e.g. an existing rule with the same explicit `name`) as
 * unowned and only takes it over with `--adopt`. The built-in
 * `RootManageSharedAccessKey` rule is never deleted.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-sas
 *
 * ### Creating a Rule
 * **Example:** Send-only connection string for a producer
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const producer = yield* Azure.ServiceBus.NamespaceAuthorizationRule(
 *   "producer",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: bus.namespaceName,
 *     rights: ["Send"],
 *   },
 * );
 * // producer.primaryConnectionString is a Redacted secret
 * ```
 *
 * **Example:** Listen and send
 * ```typescript
 * const worker = yield* Azure.ServiceBus.NamespaceAuthorizationRule("worker", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   rights: ["Listen", "Send"],
 * });
 * ```
 *
 * @resource
 */
export const NamespaceAuthorizationRule = Resource<NamespaceAuthorizationRule>(
  "Azure.ServiceBus.NamespaceAuthorizationRule",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  authorizationRuleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(servicebus.GetNamespaceAuthorizationRule(where));

const toAttrs = Effect.fn(function* (
  where: Where,
  rule: servicebus.GetNamespaceAuthorizationRuleResponse,
) {
  const keys = yield* orUndefinedIfNotFound(
    servicebus.ListNamespaceKeys(where),
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
          (yield* createEntityName(id, 50)),
      };
      const observed = yield* getRule(where);
      if (observed === undefined) return undefined;
      const attrs = yield* toAttrs(where, observed);
      // No tags or metadata: only a rule we already track is provably ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        namespaceName: news.namespace,
        authorizationRuleName:
          news.name ??
          output?.authorizationRuleName ??
          (yield* createEntityName(id, 50)),
      };
      const rights = normalizeRights(news.rights);

      // Observe.
      const observed = yield* getRule(where);

      // Ensure + sync rights.
      if (
        observed === undefined ||
        !rightsEqual(observed.properties?.rights, rights)
      ) {
        yield* servicebus.NamespacesCreateOrUpdateAuthorizationRule({
          ...where,
          properties: { rights },
        });
      }

      const fresh = yield* waitForProvisioned(
        `service bus namespace rule ${where.authorizationRuleName}`,
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
      yield* ignoreNotFound(servicebus.DeleteNamespaceAuthorizationRule(where));
      yield* waitUntilGone(
        `service bus namespace rule ${output.authorizationRuleName}`,
        getRule(where),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Namespace"] },
  });
