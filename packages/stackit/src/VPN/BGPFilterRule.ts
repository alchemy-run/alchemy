import * as vpn from "@distilled.cloud/stackit/vpn";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { conflictRetry } from "../internal/displayNames.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { covers } from "../LoadBalancer/internal.ts";
import type { Providers } from "../Providers.ts";
import {
  isGeneratedName,
  listFilterRules,
  listGatewayFilters,
  listOwnedGateways,
  requireId,
} from "./internal.ts";

/** What a route has to match. Every field set has to match. */
export interface BGPFilterRuleMatch {
  /** The AS path holds any of these ASNs, at most 10. */
  asPathContainsAny?: number[];
  /** The route carries any of these standard communities (`asn:value`), at most 20. */
  communities?: string[];
  /** The first ASN of the AS path, the immediate neighbor, is this one. */
  firstASN?: number;
  /** The route's prefix equals one of these IPv4 networks, at most 20. */
  prefixes?: string[];
  /** Shortest mask length to match, 0 to 32. */
  minPrefixLength?: number;
  /** Longest mask length to match, 0 to 32. */
  maxPrefixLength?: number;
  /** The neighbor that advertised the route has this IPv4 address. */
  peer?: string;
}

/** BGP attributes to set on a permitted route. */
export interface BGPFilterRuleSet {
  /** BGP LOCAL_PREF to set, 0 to 65535. Higher values are preferred. */
  localPreference?: number;
}

export interface BGPFilterRuleProps extends ProjectScopedProps {
  /** Id of the gateway, e.g. `gateway.gatewayId`. Changing it replaces the rule. */
  gatewayId: string;
  /** Id of the filter, e.g. `filter.filterId`. Changing it replaces the rule. */
  filterId: string;
  /**
   * Position of the rule, 1 to 65535. Lower numbers are evaluated first and the first match
   * decides. Unique within a filter. Updates in place.
   */
  sequence: number;
  /** What to do with a route that matches. Updates in place. */
  action: "PERMIT" | "DENY";
  /**
   * What a route has to match. Without it, the rule matches every route. Updates in place.
   */
  match?: BGPFilterRuleMatch;
  /** Attributes to set on a route when `action` is `PERMIT`. Updates in place. */
  set?: BGPFilterRuleSet;
}

export interface BGPFilterRuleAttributes {
  /** STACKIT rule id (UUID). Stable across updates. */
  ruleId: string;
  /** Id of the filter. */
  filterId: string;
  /** Id of the gateway. */
  gatewayId: string;
  /** Project of the gateway. */
  projectId: string;
  /** Region of the gateway. */
  region: string;
  /** Position of the rule. */
  sequence: number | undefined;
  /** What the rule does with a route that matches. */
  action: "PERMIT" | "DENY";
  /** What a route has to match, if anything. */
  match: BGPFilterRuleMatch | undefined;
  /** Attributes the rule sets, if any. */
  set: BGPFilterRuleSet | undefined;
}

export type BGPFilterRule = Resource<
  "Stackit.VPN.BGPFilterRule",
  BGPFilterRuleProps,
  BGPFilterRuleAttributes,
  never,
  Providers
>;

/**
 * One rule of a `Stackit.VPN.BGPFilter`. Rules run in `sequence` order, the first match
 * decides, and a route no rule permits is dropped.
 *
 * The API has no labels or names on rules, and `sequence` is the only thing unique in a
 * filter. So a rule found at this `sequence` without state is reported as unowned, and only
 * taken over with `--adopt`. That includes a rule whose deploy crashed before saving it.
 *
 * Everything but the gateway and filter updates in place. Moving rules past each other in one
 * deploy can collide on a `sequence`: each update retries the collision for about 50 seconds,
 * then fails with `Conflict`, so two rules swapping places need a deploy in between.
 *
 * See [STACKIT's VPN docs](https://docs.stackit.cloud/products/network/connectivity-hybrid-multi-cloud/vpn/).
 *
 * :::caution[Changing `gatewayId`, `filterId`, `projectId` or `region` replaces the Rule]
 * A new rule is created on the new filter and the old one is deleted. Everything else
 * updates in place.
 * :::
 *
 * ### Creating a Rule
 * **Example:** Permit a prefix range and prefer it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const gateway = yield* Stackit.VPN.Gateway("Backbone", {
 *   planId: "p100",
 *   routingType: "BGP_ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   bgp: { localAsn: 64512 },
 * });
 * const filter = yield* Stackit.VPN.BGPFilter("Inbound", {
 *   gatewayId: gateway.gatewayId,
 * });
 * const rule = yield* Stackit.VPN.BGPFilterRule("AllowOffice", {
 *   gatewayId: gateway.gatewayId,
 *   filterId: filter.filterId,
 *   sequence: 10,
 *   action: "PERMIT",
 *   match: { prefixes: ["192.168.0.0/16"], maxPrefixLength: 24 },
 *   set: { localPreference: 200 },
 * });
 * ```
 *
 * **Example:** Deny routes from one neighbor's AS, then permit the rest
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const gateway = yield* Stackit.VPN.Gateway("Backbone", {
 *   planId: "p100",
 *   routingType: "BGP_ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   bgp: { localAsn: 64512 },
 * });
 * const filter = yield* Stackit.VPN.BGPFilter("Inbound", {
 *   gatewayId: gateway.gatewayId,
 * });
 * const deny = yield* Stackit.VPN.BGPFilterRule("DenyTransit", {
 *   gatewayId: gateway.gatewayId,
 *   filterId: filter.filterId,
 *   sequence: 10,
 *   action: "DENY",
 *   match: { asPathContainsAny: [64700] },
 * });
 * const permit = yield* Stackit.VPN.BGPFilterRule("PermitRest", {
 *   gatewayId: gateway.gatewayId,
 *   filterId: filter.filterId,
 *   sequence: 20,
 *   action: "PERMIT",
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Read a rule from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const AllowOffice = Stackit.VPN.BGPFilterRule("AllowOffice", {
 *   gatewayId: "11111111-1111-4111-8111-111111111111",
 *   filterId: "22222222-2222-4222-8222-222222222222",
 *   sequence: 10,
 *   action: "PERMIT",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getRule = yield* Stackit.VPN.GetBGPFilterRule(yield* AllowOffice);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rule = yield* getRule();
 *         return yield* HttpServerResponse.json({ action: rule.action });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetBGPFilterRuleHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving a rule to another filter
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new filter id replaces the rule, and so does anything replacing the filter. When the
 * // id isn't known until the filter deploys, the old rule goes first: it could resolve to
 * // the same filter, where `sequence` can't be held twice.
 * const gateway = yield* Stackit.VPN.Gateway("Backbone", {
 *   planId: "p100",
 *   routingType: "BGP_ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   bgp: { localAsn: 64512 },
 * });
 * const filter = yield* Stackit.VPN.BGPFilter("Other", {
 *   gatewayId: gateway.gatewayId,
 * });
 * const rule = yield* Stackit.VPN.BGPFilterRule("AllowOffice", {
 *   gatewayId: gateway.gatewayId,
 *   filterId: filter.filterId,
 *   sequence: 10,
 *   action: "PERMIT",
 * });
 * ```
 *
 * @resource
 * @product STACKIT VPN
 * @category VPN
 */
export const BGPFilterRule = Resource<BGPFilterRule>("Stackit.VPN.BGPFilterRule");

/** A rule's delete is synchronous in the spec (204): this absorbs read lag. */
const RULE_DELETE_TIMEOUT = "2 minutes";

type FilterScope = ProjectScope & { readonly gatewayId: string; readonly filterId: string };

const getRuleOrUndefined = (scope: FilterScope, ruleId: string) =>
  vpn
    .getGatewayBGPFilterRule({ ...scope, ruleId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (
  scope: FilterScope,
  ruleId: string,
  rule: vpn.BGPFilterRule,
): BGPFilterRuleAttributes => ({
  ruleId,
  ...scope,
  sequence: rule.sequence,
  action: rule.action,
  match: rule.match,
  set: rule.set,
});

const findBySequence = (scope: FilterScope, sequence: number) =>
  listFilterRules(scope, scope.gatewayId, scope.filterId).pipe(
    Effect.map((rules) => rules.find((rule) => rule.sequence === sequence)),
  );

const sameRule = (news: BGPFilterRuleProps, observed: vpn.BGPFilterRule) =>
  observed.action === news.action &&
  observed.sequence === news.sequence &&
  covers(news.match, observed.match) &&
  covers(news.set, observed.set);

export const BGPFilterRuleProvider = () =>
  Provider.succeed(BGPFilterRule, {
    stables: ["ruleId", "filterId", "gatewayId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.VPN.BGPFilter", "Stackit.VPN.Gateway"] },

    // A rule has nothing to mark it, so nuke takes what sits on a filter Alchemy named.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectScope = { projectId: env.projectId, region: env.region };
      const gateways = yield* listOwnedGateways(projectScope);
      const attrs: BGPFilterRuleAttributes[] = [];
      for (const gateway of gateways) {
        if (gateway.id === undefined) continue;
        const filters = yield* listGatewayFilters(projectScope, gateway.id);
        for (const filter of filters) {
          if (filter.id === undefined || !isGeneratedName(filter.displayName)) continue;
          const scope = { ...projectScope, gatewayId: gateway.id, filterId: filter.id };
          const rules = yield* listFilterRules(projectScope, gateway.id, filter.id);
          for (const rule of rules) {
            if (rule.id !== undefined) attrs.push(toAttrs(scope, rule.id, rule));
          }
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the filter the rule already sits on, and a
      // `sequence` can't be held twice there: delete the old rule first.
      if (
        hasUnresolvedTrigger<BGPFilterRuleProps>(news, [
          "gatewayId",
          "filterId",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<BGPFilterRuleProps>(news);
      if (
        (yield* projectScopeChanged(resolved, output)) ||
        resolved.gatewayId !== output.gatewayId ||
        resolved.filterId !== output.filterId
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const projectScope = yield* resolveProjectScope(olds, output);
      const gatewayId = output?.gatewayId ?? olds?.gatewayId;
      const filterId = output?.filterId ?? olds?.filterId;
      if (gatewayId === undefined || filterId === undefined) return undefined;
      const scope = { ...projectScope, gatewayId, filterId };
      if (output?.ruleId !== undefined) {
        const byId = yield* getRuleOrUndefined(scope, output.ruleId);
        if (byId !== undefined) return toAttrs(scope, output.ruleId, byId);
      }
      const sequence = output?.sequence ?? olds?.sequence;
      if (sequence === undefined) return undefined;
      const found = yield* findBySequence(scope, sequence);
      if (found?.id === undefined) return undefined;
      const attrs = toAttrs(scope, found.id, found);
      // No labels, no generated name: nothing proves a rule at this position is ours, unless
      // it is the generation being replaced. A rule id says nothing outside its filter.
      const isPrevious =
        previous?.ruleId === found.id &&
        previous.filterId === filterId &&
        previous.gatewayId === gatewayId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const projectScope = yield* resolveProjectScope(news, output);
      const scope = { ...projectScope, gatewayId: news.gatewayId, filterId: news.filterId };

      // 1. Observe — `output` is a cache for the id, and only names the desired rule while
      // it sits on the same filter.
      let current: vpn.BGPFilterRule | undefined =
        output?.ruleId !== undefined &&
        output.filterId === scope.filterId &&
        output.gatewayId === scope.gatewayId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* getRuleOrUndefined(scope, output.ruleId)
          : undefined;

      // 2. Ensure — a 409 is a rule at this `sequence`. Only one exactly like this rule can
      // be our own create racing; anything else is someone else's, and stays theirs.
      if (current === undefined) {
        current = yield* vpn
          .createGatewayBGPFilterRule({
            ...scope,
            sequence: news.sequence,
            action: news.action,
            match: news.match,
            set: news.set,
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              findBySequence(scope, news.sequence).pipe(
                Effect.flatMap((found) =>
                  found !== undefined && sameRule(news, found)
                    ? Effect.succeed(found)
                    : Effect.fail(error),
                ),
              ),
            ),
          );
      }
      const ruleId = yield* requireId(`BGP filter rule ${news.sequence}`, current.id);

      // 3. Sync — observed state can't show a field the user removed, since `covers` ignores
      // what the props leave out, so the previous props flag that.
      const declarationChanged =
        olds !== undefined &&
        (JSON.stringify(olds.match) !== JSON.stringify(news.match) ||
          JSON.stringify(olds.set) !== JSON.stringify(news.set));
      if (declarationChanged || !sameRule(news, current)) {
        // The rule this one is moving past may still hold the `sequence`.
        current = yield* vpn
          .updateGatewayBGPFilterRule({
            ...scope,
            ruleId,
            sequence: news.sequence,
            action: news.action,
            match: news.match,
            set: news.set,
          })
          .pipe(Effect.retry(conflictRetry));
      }

      // 4. Return
      return toAttrs(scope, ruleId, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = {
        projectId: output.projectId,
        region: output.region,
        gatewayId: output.gatewayId,
        filterId: output.filterId,
      };
      yield* vpn
        .deleteGatewayBGPFilterRule({ ...scope, ruleId: output.ruleId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT VPN BGP filter rule ${output.ruleId}`,
        read: getRuleOrUndefined(scope, output.ruleId),
        timeout: RULE_DELETE_TIMEOUT,
      });
    }),
  });
