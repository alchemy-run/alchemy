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

export type { AccessRight };

/** Built-in namespace rule Azure creates; Alchemy never deletes it. */
export const ROOT_MANAGE_RULE = "RootManageSharedAccessKey";

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
   * `bus.namespaceName` of an `Azure.ServiceBus.Namespace`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  namespace: string;
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

export interface NamespaceAuthorizationRule extends Resource<
  "Azure.ServiceBus.NamespaceAuthorizationRule",
  NamespaceAuthorizationRuleProps,
  {
    /** Name of the rule. */
    authorizationRuleName: string;
    /**
     * ARM resource ID of the rule
     * (`/subscriptions/.../namespaces/{namespace}/authorizationRules/{name}`).
     */
    authorizationRuleId: string;
    /** Name of the namespace the rule grants access to. */
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
     * (`Endpoint=sb://...;SharedAccessKeyName=...;SharedAccessKey=...`), as a
     * secret.
     */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Secondary connection string, as a secret. */
    secondaryConnectionString: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Bus namespace SAS rule
 * (`Microsoft.ServiceBus/namespaces/authorizationRules`): a shared access
 * key that grants `Listen`, `Send`, and/or `Manage` on every queue and
 * topic in the namespace. Use its connection strings for clients that
 * cannot use Entra ID (an SDK or tool that only takes a connection string).
 * For an Alchemy host, prefer a binding such as
 * `Azure.ServiceBus.QueueSend`: it assigns a role and needs no key.
 *
 * :::caution[Changing `name`, `namespace`, or `resourceGroup` replaces the rule]
 * Alchemy creates a new rule with new keys and deletes the old one.
 * Clients that use the old connection string stop working.
 * :::
 *
 * :::caution[The namespace must exist]
 * Create the `Azure.ServiceBus.Namespace` first and pass its
 * `namespaceName`. Deleting the namespace deletes its rules.
 * :::
 *
 * Authorization rules have no tags or metadata: Alchemy treats a rule it
 * did not create (e.g. an existing rule with the same explicit `name`) as
 * unowned and only takes it over with `--adopt`. Alchemy never deletes the
 * built-in `RootManageSharedAccessKey` rule.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-sas
 *
 * ### Creating a Rule
 * **Example:** Send-only connection string for a producer
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * const producer = yield* Azure.ServiceBus.NamespaceAuthorizationRule(
 *   "producer",
 *   {
 *     namespace: bus.namespaceName,
 *     rights: ["Send"],
 *   },
 * );
 * // producer.primaryConnectionString is a Redacted secret
 * ```
 *
 * **Example:** Listen and send
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * const worker = yield* Azure.ServiceBus.NamespaceAuthorizationRule("worker", {
 *   namespace: bus.namespaceName,
 *   rights: ["Listen", "Send"],
 * });
 * ```
 *
 * ### Managing the Namespace
 * **Example:** A rule for an admin tool
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * const admin = yield* Azure.ServiceBus.NamespaceAuthorizationRule("admin", {
 *   namespace: bus.namespaceName,
 *   // Manage implies Listen and Send
 *   rights: ["Manage"],
 * });
 * ```
 *
 * @resource
 */
export const NamespaceAuthorizationRule = GroupedResource<NamespaceAuthorizationRule>(
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
  const keys = yield* orUndefinedIfNotFound(servicebus.ListNamespaceKeys(where));
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
    stables: ["authorizationRuleName", "authorizationRuleId", "namespaceName", "resourceGroup"],

    // Rules live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
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
      if (resourceGroupName === undefined || namespaceName === undefined) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
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
        authorizationRuleName:
          news.name ?? output?.authorizationRuleName ?? (yield* createEntityName(id, 50)),
      };
      const rights = normalizeRights(news.rights);

      // Observe.
      const observed = yield* getRule(where);

      // Ensure + sync rights.
      if (observed === undefined || !rightsEqual(observed.properties?.rights, rights)) {
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
