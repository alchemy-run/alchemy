import * as relay from "@distilled.cloud/azure/relay";
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

export interface HybridConnectionAuthorizationRuleProps {
  /** Resource group of the namespace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Relay namespace that holds the hybrid connection. Changing it replaces the rule. */
  namespace: string;
  /** Hybrid connection the rule grants access to. Changing it replaces the rule. */
  hybridConnection: string;
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

export interface HybridConnectionAuthorizationRule extends Resource<
  "Azure.Relay.HybridConnectionAuthorizationRule",
  HybridConnectionAuthorizationRuleProps,
  {
    /** Name of the rule. */
    authorizationRuleName: string;
    /** ARM resource ID of the rule. */
    authorizationRuleId: string;
    /** Hybrid connection the rule grants access to. */
    hybridConnectionName: string;
    /** Namespace that holds the hybrid connection. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Granted rights (sorted; `Manage` implies `Listen` and `Send`). */
    rights: AccessRight[];
    /** Primary SAS key. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** Primary connection string (with `EntityPath=<hybrid connection>`). */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Secondary connection string. */
    secondaryConnectionString: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A shared access (SAS) authorization rule scoped to a single Azure Relay
 * hybrid connection. It grants `Listen`, `Send`, and/or `Manage` on that
 * connection only and exposes the rule's keys and connection strings as
 * secrets.
 *
 * Authorization rules have no tags or metadata: Alchemy treats a rule it
 * did not create (e.g. an existing rule with the same explicit `name`) as
 * unowned and only takes it over with `--adopt`.
 *
 * @see https://learn.microsoft.com/azure/azure-relay/relay-authentication-and-authorization
 *
 * ### Creating a Rule
 * **Example:** Separate listener and sender credentials
 * ```typescript
 * const hc = yield* Azure.Relay.HybridConnection("onprem-api", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 * });
 * const listener = yield* Azure.Relay.HybridConnectionAuthorizationRule(
 *   "listener",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: ns.namespaceName,
 *     hybridConnection: hc.hybridConnectionName,
 *     rights: ["Listen"],
 *   },
 * );
 * const sender = yield* Azure.Relay.HybridConnectionAuthorizationRule(
 *   "sender",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: ns.namespaceName,
 *     hybridConnection: hc.hybridConnectionName,
 *     rights: ["Send"],
 *   },
 * );
 * ```
 *
 * @resource
 */
export const HybridConnectionAuthorizationRule =
  Resource<HybridConnectionAuthorizationRule>(
    "Azure.Relay.HybridConnectionAuthorizationRule",
  );

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  hybridConnectionName: string;
  authorizationRuleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(relay.GetHybridConnectionAuthorizationRule(where));

const toAttrs = Effect.fn(function* (
  where: Where,
  rule: relay.GetHybridConnectionAuthorizationRuleResponse,
) {
  const keys = yield* orUndefinedIfNotFound(
    relay.ListHybridConnectionKeys(where),
  );
  return {
    authorizationRuleName: where.authorizationRuleName,
    authorizationRuleId: rule.id ?? "",
    hybridConnectionName: where.hybridConnectionName,
    namespaceName: where.namespaceName,
    resourceGroup: where.resourceGroupName,
    rights: normalizeRights(rule.properties?.rights ?? []),
    ...toSecrets(keys ?? {}),
  } satisfies HybridConnectionAuthorizationRule["Attributes"];
});

export const HybridConnectionAuthorizationRuleProvider = () =>
  Provider.succeed(HybridConnectionAuthorizationRule, {
    stables: [
      "authorizationRuleName",
      "authorizationRuleId",
      "hybridConnectionName",
      "namespaceName",
      "resourceGroup",
    ],

    // Rules live inside a hybrid connection; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        !sameName(news.hybridConnection, output.hybridConnectionName) ||
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
      const hybridConnectionName =
        output?.hybridConnectionName ?? olds?.hybridConnection;
      if (
        resourceGroupName === undefined ||
        namespaceName === undefined ||
        hybridConnectionName === undefined
      ) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        hybridConnectionName,
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Relay");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        namespaceName: news.namespace,
        hybridConnectionName: news.hybridConnection,
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
        yield* relay.HybridConnectionsCreateOrUpdateAuthorizationRule({
          ...where,
          properties: { rights },
        });
      }

      const fresh = yield* waitForProvisioned(
        `relay hybrid connection rule ${where.authorizationRuleName}`,
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
        hybridConnectionName: output.hybridConnectionName,
        authorizationRuleName: output.authorizationRuleName,
      };
      yield* ignoreNotFound(
        relay.DeleteHybridConnectionAuthorizationRule(where),
      );
      yield* waitUntilGone(
        `relay hybrid connection rule ${output.authorizationRuleName}`,
        getRule(where),
      );
    }),

    nuke: { dependsOn: ["Azure.Relay.HybridConnection"] },
  });
