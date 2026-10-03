import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Observability.ZoneTracingRules" as const;
type TypeId = typeof TypeId;

/** One trace rule: a sampling ratio for the requests an expression selects. */
export interface ZoneTracingRule {
  /**
   * A Rules language expression that selects requests, e.g.
   * `http.request.uri.path wildcard "/api/*"`.
   */
  expression: string;
  /**
   * The ratio of matching requests sampled for tracing, from `0` to `1`.
   * `0` stops tracing them.
   */
  samplingRatio: number;
  /**
   * A description shown beside the rule in the dashboard.
   * @default ""
   */
  description?: string;
  /**
   * Whether the rule is evaluated.
   * @default true
   */
  enabled?: boolean;
}

export interface ZoneTracingRulesProps {
  /**
   * Zone whose trace rules are managed. Stable — changing the zone triggers
   * a replacement (the old zone's rules are deleted, the new zone's are
   * written).
   */
  zoneId: string;
  /**
   * The rules in evaluation order. The first rule that matches a request
   * decides its sampling ratio; a request no rule matches is sampled at the
   * zone's default ({@link ZoneTracing} `samplingRatio`).
   */
  rules: ZoneTracingRule[];
}

export interface ZoneTracingRulesAttributes {
  /** Zone the rules belong to. */
  zoneId: string;
  /** The rules in evaluation order, as Cloudflare reports them. */
  rules: Required<ZoneTracingRule>[];
}

export type ZoneTracingRules = Resource<
  TypeId,
  ZoneTracingRulesProps,
  ZoneTracingRulesAttributes,
  never,
  Providers
>;

/**
 * The trace rules of a zone (`/zones/{zone_id}/observability/tracing/rules`):
 * ordered overrides of the Cloudflare Traces sampling ratio for the requests
 * a Rules language expression selects.
 *
 * The rules live in one managed ruleset per zone, so this resource owns the
 * whole list: deploy replaces it with `rules`, and destroy deletes every
 * rule. The zone's tracing settings themselves are {@link ZoneTracing}.
 * ### Sampling by path
 * **Example:** Trace every API request and no static asset
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Observability.ZoneTracing("Tracing", {
 *   zoneId: zone.zoneId,
 *   samplingRatio: 0.01,
 * });
 *
 * yield* Cloudflare.Observability.ZoneTracingRules("TraceRules", {
 *   zoneId: zone.zoneId,
 *   rules: [
 *     {
 *       description: "Every API request",
 *       expression: 'starts_with(http.request.uri.path, "/api/")',
 *       samplingRatio: 1,
 *     },
 *     {
 *       description: "No static assets",
 *       expression: 'starts_with(http.request.uri.path, "/assets/")',
 *       samplingRatio: 0,
 *     },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/observability/traces/configuration/#trace-rules
 *
 * @resource
 * @product Observability
 * @category Observability & Analytics
 */
export const ZoneTracingRules = Resource<ZoneTracingRules>(TypeId);

/**
 * Returns true if the given value is a ZoneTracingRules resource.
 */
export const isZoneTracingRules = (value: unknown): value is ZoneTracingRules =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

type ObservedRule =
  | zones.GetObservabilityTracingRuleResponseRulesItem
  | zones.UpdateObservabilityTracingRuleResponseRulesItem;

const normalize = (rule: ZoneTracingRule): Required<ZoneTracingRule> => ({
  expression: rule.expression,
  samplingRatio: rule.samplingRatio,
  description: rule.description ?? "",
  enabled: rule.enabled ?? true,
});

const fromObserved = (rule: ObservedRule): Required<ZoneTracingRule> => ({
  expression: rule.expression,
  samplingRatio: rule.actionParameters.samplingRatio,
  description: rule.description,
  enabled: rule.enabled,
});

/** Order-sensitive equality: evaluation order is part of the rules. */
const rulesEqual = (
  a: readonly Required<ZoneTracingRule>[],
  b: readonly Required<ZoneTracingRule>[],
): boolean =>
  a.length === b.length &&
  a.every(
    (rule, i) =>
      rule.expression === b[i]!.expression &&
      rule.samplingRatio === b[i]!.samplingRatio &&
      rule.description === b[i]!.description &&
      rule.enabled === b[i]!.enabled,
  );

export const ZoneTracingRulesProvider = () =>
  Provider.succeed(ZoneTracingRules, {
    nuke: { singleton: true },
    stables: ["zoneId"],

    // A per-zone ruleset with no account-wide enumeration API.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as ZoneTracingRulesProps;
      const n = news as ZoneTracingRulesProps;
      // zoneId is Input<string>; compare only once both sides are concrete.
      const oldZoneId =
        output?.zoneId ?? (typeof o.zoneId === "string" ? o.zoneId : undefined);
      if (
        oldZoneId !== undefined &&
        typeof n.zoneId === "string" &&
        oldZoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (!zoneId) return undefined;
      // The ruleset carries no ownership marker — a cold read adopts it;
      // reconcile replaces it with the props.
      const observed = yield* zones.getObservabilityTracingRule({ zoneId });
      return toAttributes(zoneId, observed.rules);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const desired = news.rules.map(normalize);

      // Observe, then PUT the whole list only when it differs: the API
      // replaces every rule at once.
      const observed = yield* zones.getObservabilityTracingRule({ zoneId });
      if (rulesEqual(observed.rules.map(fromObserved), desired)) {
        return toAttributes(zoneId, observed.rules);
      }
      const updated = yield* zones.updateObservabilityTracingRule({
        zoneId,
        rules: desired.map((rule) => ({
          action: "set_trace_settings",
          actionParameters: { samplingRatio: rule.samplingRatio },
          description: rule.description,
          enabled: rule.enabled,
          expression: rule.expression,
        })),
      });
      return toAttributes(zoneId, updated.rules);
    }),

    delete: Effect.fn(function* ({ output }) {
      // DELETE empties the ruleset, so it is safe to repeat.
      yield* zones.deleteObservabilityTracingRule({ zoneId: output.zoneId });
    }),
  });

const toAttributes = (
  zoneId: string,
  rules: readonly ObservedRule[],
): ZoneTracingRulesAttributes => ({
  zoneId,
  rules: rules.map(fromObserved),
});
