import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { conflictRetry } from "../internal/displayNames.ts";
import { childrenLeftAfterSettling } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  generatedName,
  isGeneratedName,
  listFilterRules,
  listGatewayFilters,
  listOwnedGateways,
  requireId,
  settleGateway,
} from "./internal.ts";

export interface BGPFilterProps extends ProjectScopedProps {
  /** Id of the gateway, e.g. `gateway.gatewayId`. Changing it replaces the filter. */
  gatewayId: string;
  /**
   * Name of the filter: 1-63 letters, digits and hyphens, starting and ending with a
   * letter or digit. STACKIT doesn't require it to be unique. Updates in place.
   * @default a physical name generated from the stack, stage and logical id
   */
  displayName?: string;
  /**
   * Let a delete take rules this stack doesn't manage with it. Without it, any that
   * remain stop the delete with `Stackit.VPN.BGPFilterNotEmpty`.
   * @default false
   */
  forceDestroy?: boolean;
}

export interface BGPFilterAttributes {
  /** STACKIT filter id (UUID). Stable across updates. */
  filterId: string;
  /** Id of the gateway. */
  gatewayId: string;
  /** Project of the gateway. */
  projectId: string;
  /** Region of the gateway. */
  region: string;
  /** Name of the filter. */
  displayName: string;
}

export type BGPFilter = Resource<
  "Stackit.VPN.BGPFilter",
  BGPFilterProps,
  BGPFilterAttributes,
  never,
  Providers
>;

/** A BGP filter holds rules this stack doesn't manage. */
export class BGPFilterNotEmpty extends Data.TaggedError("Stackit.VPN.BGPFilterNotEmpty")<{
  readonly filterId: string;
  readonly ruleIds: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * A named set of rules deciding which BGP routes a tunnel of a `BGP_ROUTE_BASED`
 * `Stackit.VPN.Gateway` accepts. Attach it with `bgp.inboundFilterId` on a
 * `Stackit.VPN.Connection`, and add rules with `Stackit.VPN.BGPFilterRule`.
 *
 * A filter ends in an implicit deny, so a filter with no rules attached to a tunnel denies
 * every route. Deploy the rules before attaching it. A gateway holds as many filters as its
 * plan has connections, and each filter holds at most 10 rules.
 *
 * The API has no labels on filters. The id in state is what identifies one, and a filter with
 * a generated name can be found again after a crashed deploy, because the name carries its
 * generation. An explicit name proves nothing, since STACKIT doesn't require it to be unique,
 * so it is never looked up: a deploy that crashes between creating such a filter and saving
 * it leaves that filter behind.
 *
 * STACKIT refuses to delete a filter a tunnel still references. A delete retries that for
 * two minutes, so the connection's own update can land, and then fails with `Conflict`.
 *
 * See [STACKIT's VPN docs](https://docs.stackit.cloud/products/network/connectivity-hybrid-multi-cloud/vpn/).
 *
 * :::caution[Changing `gatewayId`, `projectId` or `region` replaces the Filter]
 * A new filter is created and the old one is deleted. STACKIT refuses to delete a
 * filter a tunnel still references: a delete retries for two minutes, so the
 * connection's own update can land, then fails with `Conflict`.
 * :::
 *
 * ### Creating a Filter
 * **Example:** A filter with a rule, attached to a connection
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const preSharedKey = Config.Redacted("VPN_PRE_SHARED_KEY");
 * const gateway = yield* Stackit.VPN.Gateway("Backbone", {
 *   planId: "p100",
 *   routingType: "BGP_ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   bgp: { localAsn: 64512 },
 * });
 * const filter = yield* Stackit.VPN.BGPFilter("Inbound", {
 *   gatewayId: gateway.gatewayId,
 *   displayName: "inbound-primary-tunnel",
 * });
 * const rule = yield* Stackit.VPN.BGPFilterRule("AllowOffice", {
 *   gatewayId: gateway.gatewayId,
 *   filterId: filter.filterId,
 *   sequence: 10,
 *   action: "PERMIT",
 *   match: { prefixes: ["192.168.0.0/16"] },
 * });
 * const phase = {
 *   encryptionAlgorithms: ["aes256" as const],
 *   integrityAlgorithms: ["sha2_384" as const],
 *   dhGroups: ["ecp384" as const],
 * };
 * const connection = yield* Stackit.VPN.Connection("Berlin", {
 *   gatewayId: gateway.gatewayId,
 *   tunnel1: {
 *     remoteAddress: "203.0.113.10",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *     bgp: { remoteAsn: 64600, inboundFilterId: filter.filterId },
 *   },
 *   tunnel2: {
 *     remoteAddress: "203.0.113.11",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *     bgp: { remoteAsn: 64600, inboundFilterId: filter.filterId },
 *   },
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Read a filter from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Inbound = Stackit.VPN.BGPFilter("Inbound", {
 *   gatewayId: "11111111-1111-4111-8111-111111111111",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listRules = yield* Stackit.VPN.ListBGPFilterRules(yield* Inbound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rules } = yield* listRules();
 *         return yield* HttpServerResponse.json({ rules: rules.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.ListBGPFilterRulesHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving a filter to another gateway
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new gateway id replaces the filter, and so does anything replacing the gateway. The
 * // new filter comes up first, and the rules on it are replaced with it. A rule this stack
 * // doesn't hold stops the old filter's delete, and forceDestroy set by then doesn't reach it,
 * // because an old filter keeps the props it was deployed with: delete that rule by hand.
 * const gateway = yield* Stackit.VPN.Gateway("BackboneB", {
 *   planId: "p100",
 *   routingType: "BGP_ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   bgp: { localAsn: 64512 },
 * });
 * const filter = yield* Stackit.VPN.BGPFilter("Inbound", {
 *   gatewayId: gateway.gatewayId,
 * });
 * ```
 *
 * @resource
 * @product STACKIT VPN
 * @category VPN
 */
export const BGPFilter = Resource<BGPFilter>("Stackit.VPN.BGPFilter");

type GatewayScope = ProjectScope & { readonly gatewayId: string };

const getFilterOrUndefined = (scope: GatewayScope, filterId: string) =>
  vpn
    .getGatewayBGPFilter({ ...scope, filterId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (
  scope: GatewayScope,
  filterId: string,
  filter: vpn.BGPFilter,
): BGPFilterAttributes => ({
  filterId,
  ...scope,
  displayName: filter.displayName,
});

/** The filter holding this generation's generated name. Only that proves a filter is ours. */
const findGenerated = (projectScope: ProjectScope, gatewayId: string, id: string) =>
  Effect.gen(function* () {
    const name = yield* generatedName(id);
    const filters = yield* listGatewayFilters(projectScope, gatewayId);
    return filters.find((filter) => filter.displayName === name);
  });

/**
 * STACKIT answers 409 while a tunnel references the filter. A connection in this stack may
 * still be on its way off it, so wait for two minutes, then surface the `Conflict`.
 */
const REFERENCED_RETRY = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 12,
} as const;

/** Refuse a delete that would take rules with it. This stack's own go before the filter. */
const assertNoRules = (scope: GatewayScope, filterId: string) =>
  Effect.gen(function* () {
    const left = yield* childrenLeftAfterSettling(
      listFilterRules(scope, scope.gatewayId, filterId),
    );
    if (left.length === 0) return;
    const ruleIds = left.flatMap((rule) => (rule.id === undefined ? [] : [rule.id]));
    return yield* new BGPFilterNotEmpty({
      filterId,
      ruleIds,
      message: `BGP filter ${filterId} still has rules: ${ruleIds.join(", ")}. Delete them first, or deploy forceDestroy: true on the filter. A filter already being replaced keeps the props it was deployed with, so only deleting them by hand finishes that replacement.`,
    });
  });

export const BGPFilterProvider = () =>
  Provider.succeed(BGPFilter, {
    stables: ["filterId", "gatewayId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.VPN.Gateway"] },

    // The API has no labels on filters, so nuke only takes the ones with a generated name,
    // on a gateway Alchemy created.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectScope = { projectId: env.projectId, region: env.region };
      const gateways = yield* listOwnedGateways(projectScope);
      const attrs: BGPFilterAttributes[] = [];
      for (const gateway of gateways) {
        if (gateway.id === undefined) continue;
        const filters = yield* listGatewayFilters(projectScope, gateway.id);
        for (const filter of filters) {
          if (filter.id === undefined || !isGeneratedName(filter.displayName)) continue;
          attrs.push(toAttrs({ ...projectScope, gatewayId: gateway.id }, filter.id, filter));
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Display names aren't unique, so the new filter can always come up first.
      if (hasUnresolvedTrigger<BGPFilterProps>(news, ["gatewayId", "projectId", "region"])) {
        return { action: "replace", deleteFirst: false } as const;
      }
      const resolved = triggerProps<BGPFilterProps>(news);
      if (
        (yield* projectScopeChanged(resolved, output)) ||
        resolved.gatewayId !== output.gatewayId
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // The name updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const projectScope = yield* resolveProjectScope(olds, output);
      const gatewayId = output?.gatewayId ?? olds?.gatewayId;
      if (gatewayId === undefined) return undefined;
      const scope = { ...projectScope, gatewayId };
      if (output?.filterId !== undefined) {
        const byId = yield* getFilterOrUndefined(scope, output.filterId);
        if (byId !== undefined) return toAttrs(scope, output.filterId, byId);
      }
      // No labels. A generated name carries this generation's id, so it is ours. An explicit
      // name isn't unique, so it says nothing, and a second filter with it is legal.
      if (olds?.displayName !== undefined) return undefined;
      const found = yield* findGenerated(projectScope, gatewayId, id);
      return found?.id === undefined ? undefined : toAttrs(scope, found.id, found);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const projectScope = yield* resolveProjectScope(news, output);
      const scope = { ...projectScope, gatewayId: news.gatewayId };
      const displayName = news.displayName ?? output?.displayName ?? (yield* generatedName(id));

      // 1. Observe — `output` is a cache for the id, and only names the desired filter while
      // it sits on the same gateway. Without it, only a generated name can be claimed.
      let current: vpn.BGPFilter | undefined =
        output?.filterId !== undefined &&
        output.gatewayId === scope.gatewayId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* getFilterOrUndefined(scope, output.filterId)
          : undefined;
      if (current === undefined && news.displayName === undefined) {
        current = yield* findGenerated(projectScope, scope.gatewayId, id);
      }
      yield* settleGateway(projectScope, scope.gatewayId);

      // 2. Ensure — the spec lists a 409 on filter writes without saying when. STACKIT's
      // Terraform provider sees them on a busy gateway, so they get a short retry.
      if (current === undefined) {
        current = yield* vpn
          .createGatewayBGPFilter({ ...scope, displayName })
          .pipe(Effect.retry(conflictRetry));
      }
      const filterId = yield* requireId(`BGP filter ${displayName}`, current.id);

      // 3. Sync
      if (current.displayName !== displayName) {
        current = yield* vpn
          .updateGatewayBGPFilter({ ...scope, filterId, displayName })
          .pipe(Effect.retry(conflictRetry));
      }

      // 4. Return
      return toAttrs(scope, filterId, current);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const projectScope = { projectId: output.projectId, region: output.region };
      const scope = { ...projectScope, gatewayId: output.gatewayId };
      const { filterId } = output;
      const current = yield* getFilterOrUndefined(scope, filterId);
      if (current === undefined) return;
      if (olds?.forceDestroy !== true && force !== true) {
        yield* assertNoRules(scope, filterId);
      }
      yield* vpn.deleteGatewayBGPFilter({ ...scope, filterId }).pipe(
        Effect.retry(REFERENCED_RETRY),
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
