import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEquals } from "../../Util/equal.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Observability.ZoneTracing" as const;
type TypeId = typeof TypeId;

/**
 * When Cloudflare continues a trace context that arrives on an inbound
 * request (a W3C `traceparent` header). `authenticated` is accepted by the
 * API but not supported yet.
 */
export type ZoneTracingPropagationPolicy =
  | "accept"
  | "authenticated"
  | "reject";

export interface ZoneTracingProps {
  /**
   * Zone whose Cloudflare Traces settings are managed. Stable — changing the
   * zone triggers a replacement (the old zone's settings are reset, the new
   * zone's are written).
   */
  zoneId: string;
  /**
   * Whether Cloudflare Traces records traces for the zone.
   * @default true
   */
  enabled?: boolean;
  /**
   * The ratio of requests sampled for tracing, from `0` to `1`. Trace rules
   * ({@link ZoneTracingRules}) override it for the requests they match.
   * Omitted fields keep the zone's current value.
   */
  samplingRatio?: number;
  /**
   * Whether traces are persisted in Cloudflare, so they appear in the
   * dashboard. `false` with {@link destinations} set is export-only.
   */
  persist?: boolean;
  /**
   * Up to 100 identifiers of account-level OpenTelemetry destinations that
   * receive the zone's traces.
   */
  destinations?: string[];
  /**
   * Whether trace context is sent externally or across a zone boundary —
   * for example to the origin, which can then continue the trace.
   */
  forwardContext?: boolean;
  /**
   * When an inbound trace context may be continued. Cloudflare does not
   * verify that an inbound context came from a trusted caller, so `accept`
   * lets any client choose the trace a request joins.
   */
  propagationPolicy?: ZoneTracingPropagationPolicy;
}

export interface ZoneTracingAttributes {
  /** Zone the settings belong to. */
  zoneId: string;
  /** Whether Cloudflare Traces is enabled for the zone. */
  enabled: boolean;
  /** The ratio of requests sampled for tracing, from `0` to `1`. */
  samplingRatio: number;
  /** Whether traces are persisted in Cloudflare. */
  persist: boolean;
  /** OpenTelemetry destination identifiers that receive traces. */
  destinations: string[];
  /** Whether trace context is sent externally or across a zone boundary. */
  forwardContext: boolean;
  /** When an inbound trace context may be continued. */
  propagationPolicy: ZoneTracingPropagationPolicy | (string & {});
}

export type ZoneTracing = Resource<
  TypeId,
  ZoneTracingProps,
  ZoneTracingAttributes,
  never,
  Providers
>;

/**
 * The Cloudflare Traces settings of a zone
 * (`/zones/{zone_id}/observability/tracing/settings`).
 *
 * Cloudflare Traces records how a request moves through Cloudflare —
 * security rules, transformations, cache, routing, Workers and the origin
 * connection — as one trace per sampled request. It is enabled per zone; a
 * Worker's own spans only appear in the trace when the Worker also has
 * Workers traces on (`observability.traces` on the Worker, or
 * `Cloudflare.Telemetry()`).
 *
 * The settings are a zone singleton that always exists, so a first deploy
 * adopts them and only the props that are set are written. Destroy resets
 * them to Cloudflare's defaults and leaves the zone's trace rules alone;
 * manage those with {@link ZoneTracingRules}.
 * ### Enabling Cloudflare Traces
 * **Example:** Trace one request in ten
 * ```typescript
 * const zone = yield* Cloudflare.Zone.Zone("Site", { name: "example.com" });
 *
 * yield* Cloudflare.Observability.ZoneTracing("Tracing", {
 *   zoneId: zone.zoneId,
 *   samplingRatio: 0.1,
 * });
 * ```
 *
 * **Example:** Export to an OpenTelemetry destination without persisting
 * ```typescript
 * yield* Cloudflare.Observability.ZoneTracing("Tracing", {
 *   zoneId: zone.zoneId,
 *   samplingRatio: 0.01,
 *   persist: false,
 *   destinations: ["my-otlp-destination"],
 * });
 * ```
 *
 * **Example:** Join traces started by the caller and forward them on
 * ```typescript
 * yield* Cloudflare.Observability.ZoneTracing("Tracing", {
 *   zoneId: zone.zoneId,
 *   propagationPolicy: "accept",
 *   forwardContext: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/observability/traces/
 *
 * @resource
 * @product Observability
 * @category Observability & Analytics
 */
export const ZoneTracing = Resource<ZoneTracing>(TypeId);

/**
 * Returns true if the given value is a ZoneTracing resource.
 */
export const isZoneTracing = (value: unknown): value is ZoneTracing =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

type Settings =
  | zones.GetObservabilityTracingSettingsResponse
  | zones.UpdateObservabilityTracingSettingsResponse;

/**
 * The fields the props ask for, in the API's request shape. A field the
 * props leave unset is left out, so the PATCH keeps its current value.
 */
const desiredSettings = (props: ZoneTracingProps) => ({
  enabled: props.enabled ?? true,
  ...(props.samplingRatio !== undefined
    ? { samplingRatio: props.samplingRatio }
    : {}),
  ...(props.persist !== undefined ? { persist: props.persist } : {}),
  ...(props.destinations !== undefined
    ? { destinations: [...props.destinations] }
    : {}),
  ...(props.forwardContext !== undefined
    ? { forwardContext: props.forwardContext }
    : {}),
  ...(props.propagationPolicy !== undefined
    ? { propagationPolicy: props.propagationPolicy }
    : {}),
});

/** Whether every field the props set already holds on the zone. */
const satisfied = (
  observed: Settings,
  desired: ReturnType<typeof desiredSettings>,
): boolean =>
  observed.enabled === desired.enabled &&
  (desired.samplingRatio === undefined ||
    observed.samplingRatio === desired.samplingRatio) &&
  (desired.persist === undefined || observed.persist === desired.persist) &&
  (desired.destinations === undefined ||
    arrayEquals([...observed.destinations], desired.destinations)) &&
  (desired.forwardContext === undefined ||
    observed.forwardContext === desired.forwardContext) &&
  (desired.propagationPolicy === undefined ||
    observed.propagationPolicy === desired.propagationPolicy);

export const ZoneTracingProvider = () =>
  Provider.succeed(ZoneTracing, {
    nuke: { singleton: true },
    stables: ["zoneId"],

    // A zone singleton with no account-wide enumeration API.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as ZoneTracingProps;
      const n = news as ZoneTracingProps;
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
      // The settings always exist and carry no ownership marker — a cold
      // read adopts them; reconcile converges them to the props.
      const observed = yield* zones.getObservabilityTracingSettings({ zoneId });
      return toAttributes(zoneId, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const desired = desiredSettings(news);

      // Observe, then PATCH only when a field the props set differs.
      const observed = yield* zones.getObservabilityTracingSettings({ zoneId });
      if (satisfied(observed, desired)) {
        return toAttributes(zoneId, observed);
      }
      const updated = yield* zones.updateObservabilityTracingSettings({
        zoneId,
        ...desired,
      });
      return toAttributes(zoneId, updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      // DELETE resets the settings to Cloudflare's defaults and keeps the
      // trace rules, so it is safe to repeat.
      yield* zones.deleteObservabilityTracingSettings({
        zoneId: output.zoneId,
      });
    }),
  });

const toAttributes = (
  zoneId: string,
  settings: Settings,
): ZoneTracingAttributes => ({
  zoneId,
  enabled: settings.enabled,
  samplingRatio: settings.samplingRatio,
  persist: settings.persist,
  destinations: [...settings.destinations],
  forwardContext: settings.forwardContext,
  propagationPolicy: settings.propagationPolicy,
});
