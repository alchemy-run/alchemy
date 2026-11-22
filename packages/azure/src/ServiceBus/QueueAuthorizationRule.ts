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

export interface QueueAuthorizationRuleProps {
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
   * Name of the namespace that holds the queue, e.g. `bus.namespaceName` of
   * an `Azure.ServiceBus.Namespace`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  namespace: string;
  /**
   * Name of the queue the rule grants access to, e.g. `orders.queueName`
   * of an `Azure.ServiceBus.Queue`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  queue: string;
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

export interface QueueAuthorizationRule extends Resource<
  "Azure.ServiceBus.QueueAuthorizationRule",
  QueueAuthorizationRuleProps,
  {
    /** Name of the rule. */
    authorizationRuleName: string;
    /**
     * ARM resource ID of the rule
     * (`/subscriptions/.../namespaces/{namespace}/queues/{queue}/authorizationRules/{name}`).
     */
    authorizationRuleId: string;
    /** Name of the queue the rule grants access to. */
    queueName: string;
    /** Name of the namespace that holds the queue. */
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
     * (`Endpoint=sb://...;SharedAccessKeyName=...;SharedAccessKey=...;EntityPath=<queue>`),
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
 * A Service Bus queue SAS rule
 * (`Microsoft.ServiceBus/namespaces/queues/authorizationRules`): a shared
 * access key that grants `Listen` (receive), `Send`, and/or `Manage` on that one queue. Its connection
 * strings carry `EntityPath=<queue>`. Use them for clients that cannot use
 * Entra ID. For an Alchemy host, prefer a binding such as
 * `Azure.ServiceBus.QueueSend` or `Azure.ServiceBus.QueueRead`: it
 * assigns a role and needs no key.
 *
 * :::caution[Changing `name`, `queue`, `namespace`, or `resourceGroup` replaces the rule]
 * Alchemy creates a new rule with new keys and deletes the old one.
 * Clients that use the old connection string stop working.
 * :::
 *
 * :::caution[The queue must exist]
 * Create the `Azure.ServiceBus.Queue` first and pass its `queueName`.
 * Deleting the queue deletes its rules.
 * :::
 *
 * Authorization rules have no tags or metadata: Alchemy treats a rule it
 * did not create (e.g. an existing rule with the same explicit `name`) as
 * unowned and only takes it over with `--adopt`.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-sas
 *
 * ### Creating a Rule
 * **Example:** Send-only connection string for one queue
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 * });
 * const producer = yield* Azure.ServiceBus.QueueAuthorizationRule("producer", {
 *   namespace: bus.namespaceName,
 *   queue: orders.queueName,
 *   rights: ["Send"],
 * });
 * // producer.primaryConnectionString is a Redacted secret
 * ```
 *
 * **Example:** Listen-only rule for a consumer
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 * });
 * const consumer = yield* Azure.ServiceBus.QueueAuthorizationRule("consumer", {
 *   namespace: bus.namespaceName,
 *   queue: orders.queueName,
 *   rights: ["Listen"],
 * });
 * ```
 *
 * @resource
 */
export const QueueAuthorizationRule = GroupedResource<QueueAuthorizationRule>(
  "Azure.ServiceBus.QueueAuthorizationRule",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  queueName: string;
  authorizationRuleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(servicebus.GetQueueAuthorizationRule(where));

const toAttrs = Effect.fn(function* (
  where: Where,
  rule: servicebus.GetQueueAuthorizationRuleResponse,
) {
  const keys = yield* orUndefinedIfNotFound(servicebus.ListQueueKeys(where));
  return {
    authorizationRuleName: where.authorizationRuleName,
    authorizationRuleId: rule.id ?? "",
    queueName: where.queueName,
    namespaceName: where.namespaceName,
    resourceGroup: where.resourceGroupName,
    rights: normalizeRights(rule.properties?.rights ?? []),
    ...toSecrets(keys ?? {}),
  } satisfies QueueAuthorizationRule["Attributes"];
});

export const QueueAuthorizationRuleProvider = () =>
  Provider.succeed(QueueAuthorizationRule, {
    stables: [
      "authorizationRuleName",
      "authorizationRuleId",
      "queueName",
      "namespaceName",
      "resourceGroup",
    ],

    // Rules live inside a queue; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        !sameName(news.queue, output.queueName) ||
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
      const queueName = output?.queueName ?? olds?.queue;
      if (
        resourceGroupName === undefined ||
        namespaceName === undefined ||
        queueName === undefined
      ) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        queueName,
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
        queueName: news.queue,
        authorizationRuleName:
          news.name ?? output?.authorizationRuleName ?? (yield* createEntityName(id, 50)),
      };
      const rights = normalizeRights(news.rights);

      // Observe.
      const observed = yield* getRule(where);

      // Ensure + sync rights.
      if (observed === undefined || !rightsEqual(observed.properties?.rights, rights)) {
        yield* servicebus.QueuesCreateOrUpdateAuthorizationRule({
          ...where,
          properties: { rights },
        });
      }

      const fresh = yield* waitForProvisioned(
        `service bus queue rule ${where.authorizationRuleName}`,
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
        queueName: output.queueName,
        authorizationRuleName: output.authorizationRuleName,
      };
      yield* ignoreNotFound(servicebus.DeleteQueueAuthorizationRule(where));
      yield* waitUntilGone(
        `service bus queue rule ${output.authorizationRuleName}`,
        getRule(where),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Queue"] },
  });
