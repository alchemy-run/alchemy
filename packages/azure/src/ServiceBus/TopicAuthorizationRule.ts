import * as servicebus from "@distilled.cloud/azure/servicebus";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  createEntityName,
  normalizeRights,
  rightsEqual,
  sameName,
  toSecrets,
} from "./internal.ts";

export interface TopicAuthorizationRuleProps {
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
   * Name of the namespace that holds the topic, e.g. `bus.namespaceName` of
   * an `Azure.ServiceBus.Namespace`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  namespace: string;
  /**
   * Name of the topic the rule grants access to, e.g. `events.topicName`
   * of an `Azure.ServiceBus.Topic`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  topic: string;
  /**
   * Rule name: 1-50 letters, digits, `.`, `-`, and `_`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Granted rights: any of `Listen`, `Send`, and `Manage`. `Manage`
   * implies `Listen` and `Send`; Alchemy adds them for you. Changing the
   * rights updates the rule in place and keeps its keys.
   */
  rights: AccessRight[];
}

export interface TopicAuthorizationRule extends Resource<
  "Azure.ServiceBus.TopicAuthorizationRule",
  TopicAuthorizationRuleProps,
  {
    /** Name of the rule. */
    authorizationRuleName: string;
    /**
     * ARM resource ID of the rule
     * (`/subscriptions/.../namespaces/{namespace}/topics/{topic}/authorizationRules/{name}`).
     */
    authorizationRuleId: string;
    /** Name of the topic the rule grants access to. */
    topicName: string;
    /** Name of the namespace that holds the topic. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Granted rights (sorted; `Manage` implies `Listen` and `Send`). */
    rights: AccessRight[];
    /** Primary SAS key, as a secret. `undefined` when Azure did not return the keys. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key, as a secret. `undefined` when Azure did not return the keys. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /**
     * Primary connection string
     * (`Endpoint=sb://...;SharedAccessKeyName=...;SharedAccessKey=...;EntityPath=<topic>`),
     * as a secret.
     */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Secondary connection string, as a secret. */
    secondaryConnectionString: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Bus topic SAS rule
 * (`Microsoft.ServiceBus/namespaces/topics/authorizationRules`): a shared
 * access key that grants `Send` (publish), `Listen` (receive from the topic's
 * subscriptions), and/or `Manage` on that one topic. Its connection
 * strings carry `EntityPath=<topic>`. Use them for clients that cannot use
 * Entra ID. For an Alchemy host, prefer a binding such as
 * `Azure.ServiceBus.TopicWrite` or `Azure.ServiceBus.SubscriptionRead`:
 * it assigns a role and needs no key.
 *
 * :::caution[Changing `name`, `topic`, `namespace`, or `resourceGroup` replaces the rule]
 * Alchemy creates a new rule with new keys and deletes the old one.
 * Clients that use the old connection string stop working.
 * :::
 *
 * :::caution[The topic must exist]
 * Create the `Azure.ServiceBus.Topic` first and pass its `topicName`.
 * Deleting the topic deletes its rules.
 * :::
 *
 * :::caution[Topics need a Standard or Premium namespace]
 * A Basic namespace has no topics. Create the namespace with
 * `sku: "Standard"` or `"Premium"`.
 * :::
 *
 * Authorization rules have no tags or metadata: Alchemy treats a rule it
 * did not create (e.g. an existing rule with the same explicit `name`) as
 * unowned and only takes it over with `--adopt`.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-sas
 *
 * ### Creating a Rule
 * **Example:** Send-only connection string for one topic
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Standard" });
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * });
 * const publisher = yield* Azure.ServiceBus.TopicAuthorizationRule("publisher", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   rights: ["Send"],
 * });
 * // publisher.primaryConnectionString is a Redacted secret
 * ```
 *
 * **Example:** Manage rule (implies Listen and Send)
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Standard" });
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * });
 * const admin = yield* Azure.ServiceBus.TopicAuthorizationRule("admin", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   rights: ["Manage"],
 * });
 * ```
 *
 * @resource
 */
export const TopicAuthorizationRule = GroupedResource<TopicAuthorizationRule>(
  "Azure.ServiceBus.TopicAuthorizationRule",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  topicName: string;
  authorizationRuleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(servicebus.GetTopicAuthorizationRule(where));

const toAttrs = Effect.fn(function* (
  where: Where,
  rule: servicebus.GetTopicAuthorizationRuleResponse,
) {
  const keys = yield* orUndefinedIfNotFound(servicebus.ListTopicKeys(where));
  return {
    authorizationRuleName: where.authorizationRuleName,
    authorizationRuleId: rule.id ?? "",
    topicName: where.topicName,
    namespaceName: where.namespaceName,
    resourceGroup: where.resourceGroupName,
    rights: normalizeRights(rule.properties?.rights ?? []),
    ...toSecrets(keys ?? {}),
  } satisfies TopicAuthorizationRule["Attributes"];
});

export const TopicAuthorizationRuleProvider = () =>
  Provider.succeed(TopicAuthorizationRule, {
    stables: [
      "authorizationRuleName",
      "authorizationRuleId",
      "topicName",
      "namespaceName",
      "resourceGroup",
    ],

    // Rules live inside a topic; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        !sameName(news.topic, output.topicName) ||
        (news.name !== undefined && !sameName(news.name, output.authorizationRuleName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      const topicName = output?.topicName ?? olds?.topic;
      if (
        resourceGroupName === undefined ||
        namespaceName === undefined ||
        topicName === undefined
      ) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        topicName,
        authorizationRuleName:
          output?.authorizationRuleName ?? olds?.name ?? (yield* createEntityName(id, 50)),
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
        topicName: news.topic,
        authorizationRuleName:
          news.name ?? output?.authorizationRuleName ?? (yield* createEntityName(id, 50)),
      };
      const rights = normalizeRights(news.rights);

      // Observe.
      const observed = yield* getRule(where);

      // Ensure + sync rights.
      if (observed === undefined || !rightsEqual(observed.properties?.rights, rights)) {
        yield* servicebus.TopicsCreateOrUpdateAuthorizationRule({
          ...where,
          properties: { rights },
        });
      }

      const fresh = yield* waitForProvisioned(
        `service bus topic rule ${where.authorizationRuleName}`,
        getRule(where),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return yield* toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
        topicName: output.topicName,
        authorizationRuleName: output.authorizationRuleName,
      };
      yield* ignoreNotFound(servicebus.DeleteTopicAuthorizationRule(where));
      yield* waitUntilGone(
        `service bus topic rule ${output.authorizationRuleName}`,
        getRule(where),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Topic"] },
  });
