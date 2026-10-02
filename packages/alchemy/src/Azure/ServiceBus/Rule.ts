import * as servicebus from "@distilled.cloud/azure/servicebus";
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
import { createEntityName, sameName } from "./internal.ts";

/** A SQL-92 subset filter evaluated against message properties. */
export interface RuleSqlFilter {
  /** SQL filter expression, e.g. `color = 'red' AND quantity > 10`. */
  sqlExpression: string;
}

/**
 * A correlation filter: matches messages whose system and user properties
 * equal every value set here (cheaper than a SQL filter).
 */
export interface RuleCorrelationFilter {
  /** Match on the `CorrelationId` system property. */
  correlationId?: string;
  /** Match on the `MessageId` system property. */
  messageId?: string;
  /** Match on the `To` system property. */
  to?: string;
  /** Match on the `ReplyTo` system property. */
  replyTo?: string;
  /** Match on the `Label` (subject) system property. */
  label?: string;
  /** Match on the `SessionId` system property. */
  sessionId?: string;
  /** Match on the `ReplyToSessionId` system property. */
  replyToSessionId?: string;
  /** Match on the `ContentType` system property. */
  contentType?: string;
  /** Match on user (application) properties. */
  properties?: Record<string, string>;
}

/** A SQL action that modifies matched messages, e.g. `SET priority = 'high'`. */
export interface RuleAction {
  /** SQL action expression, e.g. `SET sys.Label = 'routed'`. */
  sqlExpression: string;
}

export interface RuleProps {
  /** Resource group of the namespace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Namespace that holds the topic. Changing it replaces the rule. */
  namespace: string;
  /** Topic that holds the subscription. Changing it replaces the rule. */
  topic: string;
  /** Subscription the rule filters for. Changing it replaces the rule. */
  subscription: string;
  /**
   * Rule name: 1-50 letters, digits, `.`, `-`, and `_`. If omitted, a unique
   * lowercase name is generated from the app, stage, and logical ID.
   * Changing it replaces the rule.
   */
  name?: string;
  /**
   * SQL filter. Exactly one of `sqlFilter` and `correlationFilter` should be
   * set; switching between them updates the rule in place.
   */
  sqlFilter?: RuleSqlFilter;
  /** Correlation filter (used instead of `sqlFilter`). */
  correlationFilter?: RuleCorrelationFilter;
  /** Optional SQL action applied to messages the filter matches. */
  action?: RuleAction;
}

export interface Rule extends Resource<
  "Azure.ServiceBus.Rule",
  RuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Subscription the rule filters for. */
    subscriptionName: string;
    /** Topic that holds the subscription. */
    topicName: string;
    /** Namespace that holds the topic. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Filter type: `SqlFilter` or `CorrelationFilter`. */
    filterType: string | undefined;
    /** Observed SQL filter expression (for `SqlFilter` rules). */
    sqlExpression: string | undefined;
    /** Observed SQL action expression, if any. */
    actionExpression: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Bus subscription rule — a filter (SQL or correlation) plus an
 * optional SQL action that decides which topic messages a subscription
 * receives. Service Bus gives every new subscription a `$Default` rule
 * that accepts everything; a message is delivered when any rule matches,
 * so delete `$Default` out of band (or create the subscription with only
 * your own rules) to make filters exclusive.
 *
 * Rules have no tags or metadata: Alchemy treats a rule it did not create
 * (e.g. an existing rule with the same explicit `name`) as unowned and only
 * takes it over with `--adopt`.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/topic-filters
 *
 * ### Filtering a Subscription
 * **Example:** SQL filter
 * ```typescript
 * yield* Azure.ServiceBus.Rule("red-only", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   subscription: audit.subscriptionName,
 *   sqlFilter: { sqlExpression: "color = 'red'" },
 * });
 * ```
 *
 * **Example:** Correlation filter
 * ```typescript
 * yield* Azure.ServiceBus.Rule("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   subscription: audit.subscriptionName,
 *   correlationFilter: { label: "order", properties: { region: "eu" } },
 * });
 * ```
 *
 * ### Transforming Messages
 * **Example:** SQL filter with an action
 * ```typescript
 * yield* Azure.ServiceBus.Rule("tag-priority", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   subscription: audit.subscriptionName,
 *   sqlFilter: { sqlExpression: "amount > 1000" },
 *   action: { sqlExpression: "SET priority = 'high'" },
 * });
 * ```
 *
 * @resource
 */
export const Rule = Resource<Rule>("Azure.ServiceBus.Rule");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  topicName: string;
  subscriptionName: string;
  ruleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(
    servicebus.GetRule(where).pipe(
      // A missing parent subscription surfaces as `SubscriptionNotFound`.
      Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(undefined)),
    ),
  );

const toAttrs = (
  where: Where,
  rule: servicebus.GetRuleResponse,
): Rule["Attributes"] => ({
  ruleName: where.ruleName,
  ruleId: rule.id ?? "",
  subscriptionName: where.subscriptionName,
  topicName: where.topicName,
  namespaceName: where.namespaceName,
  resourceGroup: where.resourceGroupName,
  filterType: rule.properties?.filterType,
  sqlExpression: rule.properties?.sqlFilter?.sqlExpression,
  actionExpression: rule.properties?.action?.sqlExpression,
});

const desiredProperties = (news: RuleProps): servicebus.Ruleproperties =>
  news.correlationFilter !== undefined
    ? {
        filterType: "CorrelationFilter",
        correlationFilter: news.correlationFilter,
        action: news.action,
      }
    : {
        filterType: "SqlFilter",
        sqlFilter: { sqlExpression: news.sqlFilter?.sqlExpression ?? "1=1" },
        action: news.action,
      };

const CORRELATION_KEYS = [
  "correlationId",
  "messageId",
  "to",
  "replyTo",
  "label",
  "sessionId",
  "replyToSessionId",
  "contentType",
] as const;

const recordsEqual = (
  a: Record<string, string | undefined> | undefined,
  b: Record<string, string | undefined> | undefined,
) => {
  const left = Object.entries(a ?? {}).filter(([, v]) => v !== undefined);
  const right = Object.entries(b ?? {}).filter(([, v]) => v !== undefined);
  return (
    left.length === right.length &&
    left.every(([key, value]) => (b ?? {})[key] === value)
  );
};

/** Whether the observed rule differs from the desired filter/action. */
const ruleDiffers = (
  observed: servicebus.Ruleproperties | undefined,
  desired: servicebus.Ruleproperties,
) => {
  if (!sameName(observed?.filterType, desired.filterType)) return true;
  const observedAction = observed?.action?.sqlExpression ?? "";
  if (observedAction !== (desired.action?.sqlExpression ?? "")) return true;
  if (desired.filterType === "SqlFilter") {
    return (
      observed?.sqlFilter?.sqlExpression !== desired.sqlFilter?.sqlExpression
    );
  }
  const want = desired.correlationFilter ?? {};
  const have = observed?.correlationFilter ?? {};
  return (
    CORRELATION_KEYS.some((key) => have[key] !== want[key]) ||
    !recordsEqual(have.properties, want.properties)
  );
};

export const RuleProvider = () =>
  Provider.succeed(Rule, {
    stables: [
      "ruleName",
      "ruleId",
      "subscriptionName",
      "topicName",
      "namespaceName",
      "resourceGroup",
    ],

    // Rules live inside a subscription; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        !sameName(news.topic, output.topicName) ||
        !sameName(news.subscription, output.subscriptionName) ||
        (news.name !== undefined && !sameName(news.name, output.ruleName))
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
      const subscriptionName = output?.subscriptionName ?? olds?.subscription;
      if (
        resourceGroupName === undefined ||
        namespaceName === undefined ||
        topicName === undefined ||
        subscriptionName === undefined
      ) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        topicName,
        subscriptionName,
        ruleName:
          output?.ruleName ?? olds?.name ?? (yield* createEntityName(id, 50)),
      };
      const observed = yield* getRule(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
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
        subscriptionName: news.subscription,
        ruleName:
          news.name ?? output?.ruleName ?? (yield* createEntityName(id, 50)),
      };
      const properties = desiredProperties(news);

      // Observe.
      const observed = yield* getRule(where);

      // Ensure + sync: PUT is a full replace of filter and action, sent only
      // when the rule is missing or its observed filter/action differs.
      if (
        observed === undefined ||
        ruleDiffers(observed.properties, properties)
      ) {
        yield* servicebus.RulesCreateOrUpdate({ ...where, properties });
      }

      const fresh = yield* waitForProvisioned(
        `service bus rule ${where.ruleName}`,
        getRule(where),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
        topicName: output.topicName,
        subscriptionName: output.subscriptionName,
        ruleName: output.ruleName,
      };
      yield* ignoreNotFound(
        servicebus
          .DeleteRule(where)
          .pipe(
            Effect.catchTag("SubscriptionNotFound", () => Effect.void),
          ),
      );
      yield* waitUntilGone(
        `service bus rule ${output.ruleName}`,
        getRule(where),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Subscription"] },
  });
