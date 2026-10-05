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

export interface TopicAuthorizationRuleProps {
  /** Resource group of the namespace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Namespace that holds the topic. Changing it replaces the rule. */
  namespace: string;
  /** Topic the rule grants access to. Changing it replaces the rule. */
  topic: string;
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

export interface TopicAuthorizationRule extends Resource<
  "Azure.ServiceBus.TopicAuthorizationRule",
  TopicAuthorizationRuleProps,
  {
    /** Name of the rule. */
    authorizationRuleName: string;
    /** ARM resource ID of the rule. */
    authorizationRuleId: string;
    /** Topic the rule grants access to. */
    topicName: string;
    /** Namespace that holds the topic. */
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
 * A shared access (SAS) authorization rule scoped to a single Service Bus
 * topic. It grants `Listen`, `Send`, and/or `Manage` on that topic only and
 * exposes the rule's keys and connection strings (with
 * `EntityPath=<topic>`) as secrets.
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
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 * });
 * const publisher = yield* Azure.ServiceBus.TopicAuthorizationRule("publisher", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   rights: ["Send"],
 * });
 * // publisher.primaryConnectionString is a Redacted secret
 * ```
 *
 * **Example:** Manage rule (implies Listen and Send)
 * ```typescript
 * const admin = yield* Azure.ServiceBus.TopicAuthorizationRule("admin", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   rights: ["Manage"],
 * });
 * ```
 *
 * @resource
 */
export const TopicAuthorizationRule = Resource<TopicAuthorizationRule>(
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
        topicName: news.topic,
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
