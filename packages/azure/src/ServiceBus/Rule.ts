import * as servicebus from "@distilled.cloud/azure/servicebus";
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
import { createEntityName, sameName } from "./internal.ts";

/** A SQL filter: a SQL-92 subset expression evaluated against message properties. */
export interface RuleSqlFilter {
  /**
   * SQL filter expression over system (`sys.Label`) and user properties,
   * e.g. `color = 'red' AND quantity > 10`. `1=1` matches every message.
   */
  sqlExpression: string;
}

/**
 * A correlation filter: matches messages whose system and user properties
 * equal every value set here (cheaper than a SQL filter). Unset fields are
 * not compared.
 */
export interface RuleCorrelationFilter {
  /**
   * Match on the `CorrelationId` system property.
   * @default not compared
   */
  correlationId?: string;
  /**
   * Match on the `MessageId` system property.
   * @default not compared
   */
  messageId?: string;
  /**
   * Match on the `To` system property.
   * @default not compared
   */
  to?: string;
  /**
   * Match on the `ReplyTo` system property.
   * @default not compared
   */
  replyTo?: string;
  /**
   * Match on the `Label` (subject) system property, e.g. the `label` a
   * sender passes to `send`.
   * @default not compared
   */
  label?: string;
  /**
   * Match on the `SessionId` system property.
   * @default not compared
   */
  sessionId?: string;
  /**
   * Match on the `ReplyToSessionId` system property.
   * @default not compared
   */
  replyToSessionId?: string;
  /**
   * Match on the `ContentType` system property, e.g. `application/json`.
   * @default not compared
   */
  contentType?: string;
  /**
   * Match on user (application) properties: every key must be present with
   * exactly this value.
   * @default {}
   */
  properties?: Record<string, string>;
}

/** A SQL action that changes the properties of messages the filter matches. */
export interface RuleAction {
  /**
   * SQL action expression: `SET`/`REMOVE` statements, e.g.
   * `SET priority = 'high'` or `SET sys.Label = 'routed'`.
   */
  sqlExpression: string;
}

export interface RuleProps {
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
   * Name of the topic that holds the subscription, e.g. `events.topicName`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  topic: string;
  /**
   * Name of the subscription the rule filters for, e.g.
   * `audit.subscriptionName` of an `Azure.ServiceBus.Subscription`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  subscription: string;
  /**
   * Rule name: 1-50 letters, digits, `.`, `-`, and `_`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default a lowercase name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * SQL filter. Set `sqlFilter` or `correlationFilter`, not both: when both
   * are set, `correlationFilter` wins. Switching between them updates the
   * rule in place.
   * @default `{ sqlExpression: "1=1" }` (match every message) when `correlationFilter` is also unset
   */
  sqlFilter?: RuleSqlFilter;
  /**
   * Correlation filter, used instead of `sqlFilter`.
   * @default no correlation filter (the rule uses `sqlFilter`)
   */
  correlationFilter?: RuleCorrelationFilter;
  /**
   * SQL action applied to the messages the filter matches.
   * @default no action
   */
  action?: RuleAction;
}

export interface Rule extends Resource<
  "Azure.ServiceBus.Rule",
  RuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /**
     * ARM resource ID of the rule
     * (`/subscriptions/.../topics/{topic}/subscriptions/{subscription}/rules/{name}`).
     */
    ruleId: string;
    /** Name of the subscription the rule filters for. */
    subscriptionName: string;
    /** Name of the topic that holds the subscription. */
    topicName: string;
    /** Name of the namespace that holds the topic. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Filter type: `SqlFilter` or `CorrelationFilter`. */
    filterType: string | undefined;
    /** Observed SQL filter expression; `undefined` for `CorrelationFilter` rules. */
    sqlExpression: string | undefined;
    /** Observed SQL action expression; `undefined` when the rule has no action. */
    actionExpression: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Bus subscription rule
 * (`Microsoft.ServiceBus/namespaces/topics/subscriptions/rules`): a filter
 * (SQL or correlation) plus an optional SQL action that decides which
 * topic messages a subscription receives.
 *
 * :::caution[Changing `name`, `subscription`, `topic`, `namespace`, or `resourceGroup` replaces the rule]
 * Alchemy creates a new rule and deletes the old one. While both exist,
 * the subscription gets the messages either rule matches.
 * :::
 *
 * :::caution[The `$Default` rule still matches everything]
 * Service Bus gives every new subscription a `$Default` rule that accepts
 * every message. A message is delivered when any rule matches, so delete
 * `$Default` out of band to make your filters exclusive.
 * :::
 *
 * :::caution[Rules need a topic subscription, so a Standard or Premium namespace]
 * A Basic namespace has no topics. Create the namespace with
 * `sku: "Standard"` or `"Premium"`, then the topic and the subscription.
 * :::
 *
 * Rules have no tags or metadata: Alchemy treats a rule it did not create
 * (e.g. an existing rule with the same explicit `name`) as unowned and only
 * takes it over with `--adopt`.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/topic-filters
 *
 * ### Filtering a Subscription
 * Match on user properties with a SQL expression.
 *
 * **Example:** SQL filter
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Standard" });
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * });
 * const audit = yield* Azure.ServiceBus.Subscription("audit", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * yield* Azure.ServiceBus.Rule("red-only", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   subscription: audit.subscriptionName,
 *   sqlFilter: { sqlExpression: "color = 'red'" },
 * });
 * ```
 *
 * Match exact property values with a correlation filter. It is cheaper
 * than SQL.
 *
 * **Example:** Correlation filter
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Standard" });
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * });
 * const audit = yield* Azure.ServiceBus.Subscription("audit", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * yield* Azure.ServiceBus.Rule("orders", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   subscription: audit.subscriptionName,
 *   correlationFilter: { label: "order", properties: { region: "eu" } },
 * });
 * ```
 *
 * ### Transforming Messages
 * Change the properties of matched messages with an action.
 *
 * **Example:** SQL filter with an action
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Standard" });
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * });
 * const audit = yield* Azure.ServiceBus.Subscription("audit", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * yield* Azure.ServiceBus.Rule("tag-priority", {
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
export const Rule = GroupedResource<Rule>("Azure.ServiceBus.Rule");

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

const toAttrs = (where: Where, rule: servicebus.GetRuleResponse): Rule["Attributes"] => ({
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
  return left.length === right.length && left.every(([key, value]) => (b ?? {})[key] === value);
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
    return observed?.sqlFilter?.sqlExpression !== desired.sqlFilter?.sqlExpression;
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
        ruleName: output?.ruleName ?? olds?.name ?? (yield* createEntityName(id, 50)),
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
        ruleName: news.name ?? output?.ruleName ?? (yield* createEntityName(id, 50)),
      };
      const properties = desiredProperties(news);

      // Observe.
      const observed = yield* getRule(where);

      // Ensure + sync: PUT is a full replace of filter and action, sent only
      // when the rule is missing or its observed filter/action differs.
      if (observed === undefined || ruleDiffers(observed.properties, properties)) {
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
          .pipe(Effect.catchTag("SubscriptionNotFound", () => Effect.void)),
      );
      yield* waitUntilGone(`service bus rule ${output.ruleName}`, getRule(where));
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Subscription"] },
  });
