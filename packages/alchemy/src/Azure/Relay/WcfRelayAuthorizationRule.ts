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

export interface WcfRelayAuthorizationRuleProps {
  /** Resource group of the namespace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Relay namespace that holds the WCF relay. Changing it replaces the rule. */
  namespace: string;
  /** WCF relay the rule grants access to. Changing it replaces the rule. */
  wcfRelay: string;
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

export interface WcfRelayAuthorizationRule extends Resource<
  "Azure.Relay.WcfRelayAuthorizationRule",
  WcfRelayAuthorizationRuleProps,
  {
    /** Name of the rule. */
    authorizationRuleName: string;
    /** ARM resource ID of the rule. */
    authorizationRuleId: string;
    /** WCF relay the rule grants access to. */
    relayName: string;
    /** Namespace that holds the WCF relay. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Granted rights (sorted; `Manage` implies `Listen` and `Send`). */
    rights: AccessRight[];
    /** Primary SAS key. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** Primary connection string (with `EntityPath=<relay>`). */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Secondary connection string. */
    secondaryConnectionString: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A shared access (SAS) authorization rule scoped to a single Azure Relay
 * WCF relay. It grants `Listen`, `Send`, and/or `Manage` on that relay
 * only and exposes the rule's keys and connection strings as
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
 * const svc = yield* Azure.Relay.WcfRelay("legacy-svc", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 * });
 * const listener = yield* Azure.Relay.WcfRelayAuthorizationRule(
 *   "listener",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: ns.namespaceName,
 *     wcfRelay: svc.relayName,
 *     rights: ["Listen"],
 *   },
 * );
 * const sender = yield* Azure.Relay.WcfRelayAuthorizationRule(
 *   "sender",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: ns.namespaceName,
 *     wcfRelay: svc.relayName,
 *     rights: ["Send"],
 *   },
 * );
 * ```
 *
 * @resource
 */
export const WcfRelayAuthorizationRule = Resource<WcfRelayAuthorizationRule>(
  "Azure.Relay.WcfRelayAuthorizationRule",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
  relayName: string;
  authorizationRuleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(relay.GetWCFRelayAuthorizationRule(where));

const toAttrs = Effect.fn(function* (
  where: Where,
  rule: relay.GetWCFRelayAuthorizationRuleResponse,
) {
  const keys = yield* orUndefinedIfNotFound(relay.ListWCFRelayKeys(where));
  return {
    authorizationRuleName: where.authorizationRuleName,
    authorizationRuleId: rule.id ?? "",
    relayName: where.relayName,
    namespaceName: where.namespaceName,
    resourceGroup: where.resourceGroupName,
    rights: normalizeRights(rule.properties?.rights ?? []),
    ...toSecrets(keys ?? {}),
  } satisfies WcfRelayAuthorizationRule["Attributes"];
});

export const WcfRelayAuthorizationRuleProvider = () =>
  Provider.succeed(WcfRelayAuthorizationRule, {
    stables: [
      "authorizationRuleName",
      "authorizationRuleId",
      "relayName",
      "namespaceName",
      "resourceGroup",
    ],

    // Rules live inside a WCF relay; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        !sameName(news.wcfRelay, output.relayName) ||
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
      const relayName = output?.relayName ?? olds?.wcfRelay;
      if (
        resourceGroupName === undefined ||
        namespaceName === undefined ||
        relayName === undefined
      ) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        namespaceName,
        relayName,
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
        relayName: news.wcfRelay,
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
        yield* relay.WCFRelaysCreateOrUpdateAuthorizationRule({
          ...where,
          properties: { rights },
        });
      }

      const fresh = yield* waitForProvisioned(
        `relay wcf relay rule ${where.authorizationRuleName}`,
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
        relayName: output.relayName,
        authorizationRuleName: output.authorizationRuleName,
      };
      yield* ignoreNotFound(relay.DeleteWCFRelayAuthorizationRule(where));
      yield* waitUntilGone(
        `relay wcf relay rule ${output.authorizationRuleName}`,
        getRule(where),
      );
    }),

    nuke: { dependsOn: ["Azure.Relay.WcfRelay"] },
  });
