import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Api } from "./Api.ts";
import type { Providers } from "./Providers.ts";

/**
 * SLO types:
 *
 * - **`metric`** — computed from a good-events / total-events metric query
 *   pair (count-based).
 * - **`monitor`** — uptime of one or more existing monitors (time-based).
 * - **`time_slice`** — percentage of time slices where a metric condition
 *   holds (time-based, no monitor required).
 *
 * Changing `type` triggers a replacement; everything else updates in place.
 */
export type SloType = "metric" | "monitor" | "time_slice";

/** Rolling window an SLO target applies to. */
export type SloTimeframe = "7d" | "30d" | "90d" | "custom";

/** A target for one timeframe. An SLO may declare several. */
export interface SloThreshold {
  /** Rolling window this target applies to. */
  timeframe: SloTimeframe;
  /** Objective as a percentage in (0, 100), e.g. `99.9`. */
  target: number;
  /** Optional warning percentage, stricter than `target`. */
  warning?: number;
}

/**
 * Good-events / total-events query pair for `metric` SLOs. Both must be
 * count or rate metrics aggregated with `.as_count()` / `.as_rate()`.
 */
export interface SloQuery {
  /** Query counting good events, e.g. `sum:api.hits{env:prod}.as_count() - sum:api.errors{env:prod}.as_count()`. */
  numerator: string;
  /** Query counting total events, e.g. `sum:api.hits{env:prod}.as_count()`. */
  denominator: string;
}

/** A formula-and-functions metric query used by `time_slice` SLOs. */
export interface SloDataQuery {
  /** Data source, currently `"metrics"`. */
  data_source: string;
  /** Name referenced by the formula, e.g. `"query1"`. */
  name: string;
  /** The metric query, e.g. `p95:trace.express.request{env:prod}`. */
  query: string;
}

/** The SLI condition evaluated per time slice for `time_slice` SLOs. */
export interface SloTimeSliceSpec {
  time_slice: {
    query: {
      formulas: Array<{ formula: string }>;
      queries: Array<{ metric_query: SloDataQuery }>;
    };
    /** Comparison operator applied to the formula result. */
    comparator: ">" | ">=" | "<" | "<=";
    /** Threshold the formula result is compared against. */
    threshold: number;
    /** Slice size in seconds: `60` or `300`. @default 300 */
    query_interval_seconds?: number;
  };
}

/**
 * Desired state of a Datadog Service Level Objective. Field names mirror
 * the Datadog API (snake_case) verbatim.
 */
export interface ServiceLevelObjectiveProps {
  /** Name shown in the SLO list and detail pages. */
  name: string;
  /** The SLO type. Changing it forces a replacement. */
  type: SloType;
  /** Free-form description. */
  description?: string | null;
  /** Tags applied to the SLO (`key:value` strings). */
  tags?: string[];
  /** Targets, one per timeframe. At least one is required. */
  thresholds: SloThreshold[];
  /** Primary timeframe (must match one of `thresholds`). */
  timeframe?: SloTimeframe;
  /** Primary objective percentage (must match the primary threshold). */
  target_threshold?: number;
  /** Primary warning percentage. */
  warning_threshold?: number;
  /** `metric` SLOs: the good/total events query pair. */
  query?: SloQuery;
  /** `monitor` SLOs: ids of the underlying monitors. */
  monitor_ids?: number[];
  /** `monitor` SLOs over multi-alert monitors: limit to specific groups. */
  groups?: string[];
  /** `time_slice` SLOs: the SLI condition. */
  sli_specification?: SloTimeSliceSpec;
}

/** Current state of a Datadog SLO, as returned by the API. */
export interface ServiceLevelObjectiveAttributes {
  /** Server-assigned SLO id (an opaque string). */
  id: string;
  name: string;
  type: SloType;
  description?: string | null;
  tags?: string[];
  thresholds: SloThreshold[];
  timeframe?: SloTimeframe;
  target_threshold?: number;
  warning_threshold?: number;
  query?: SloQuery;
  monitor_ids?: number[];
  groups?: string[];
  sli_specification?: SloTimeSliceSpec;
  /** Unix timestamp of creation. */
  created_at?: number;
  /** Unix timestamp of last modification. */
  modified_at?: number;
}

export type ServiceLevelObjective = Resource<
  "Datadog.ServiceLevelObjective",
  ServiceLevelObjectiveProps,
  ServiceLevelObjectiveAttributes,
  never,
  Providers
>;

/**
 * A Datadog Service Level Objective — a target (e.g. 99.9% over 30 days)
 * over a service level indicator derived from metrics, monitors, or
 * time-slice conditions.
 *
 * Props mirror the [Datadog SLO API](https://docs.datadoghq.com/api/latest/service-level-objectives/)
 * verbatim (snake_case).
 *
 * Changing `type` triggers a replacement; everything else updates in place.
 * @resource
 * @see https://docs.datadoghq.com/service_management/service_level_objectives/
 *
 * @section SLOs for service endpoints (APM)
 * @example Availability of a tRPC endpoint (metric SLO)
 * ```typescript
 * yield* Datadog.ServiceLevelObjective("checkout-availability", {
 *   name: "checkout.create availability",
 *   type: "metric",
 *   description: "99.9% of checkout.create requests succeed",
 *   query: {
 *     numerator:
 *       "sum:trace.express.request.hits{env:prod,resource_name:checkout.create}.as_count() - sum:trace.express.request.errors{env:prod,resource_name:checkout.create}.as_count()",
 *     denominator:
 *       "sum:trace.express.request.hits{env:prod,resource_name:checkout.create}.as_count()",
 *   },
 *   thresholds: [{ timeframe: "30d", target: 99.9, warning: 99.95 }],
 *   timeframe: "30d",
 *   target_threshold: 99.9,
 *   tags: ["service:api", "team:payments"],
 * });
 * ```
 *
 * @example Latency SLO without a monitor (time-slice SLO)
 * ```typescript
 * yield* Datadog.ServiceLevelObjective("checkout-latency-slo", {
 *   name: "checkout.create p95 under 2s",
 *   type: "time_slice",
 *   sli_specification: {
 *     time_slice: {
 *       query: {
 *         formulas: [{ formula: "query1" }],
 *         queries: [
 *           {
 *             metric_query: {
 *               data_source: "metrics",
 *               name: "query1",
 *               query: "p95:trace.express.request{env:prod,resource_name:checkout.create}",
 *             },
 *           },
 *         ],
 *       },
 *       comparator: "<",
 *       threshold: 2,
 *     },
 *   },
 *   thresholds: [{ timeframe: "30d", target: 99 }],
 *   timeframe: "30d",
 *   target_threshold: 99,
 * });
 * ```
 *
 * @section SLOs over monitors
 * @example Uptime SLO from an existing monitor
 * ```typescript
 * const monitor = yield* Datadog.Monitor("checkout-errors", {
 *   name: "tRPC checkout.create error rate",
 *   type: "query alert",
 *   query:
 *     "sum(last_10m):sum:trace.express.request.errors{env:prod,resource_name:checkout.create}.as_count() > 10",
 * });
 *
 * yield* Datadog.ServiceLevelObjective("checkout-uptime", {
 *   name: "checkout.create uptime",
 *   type: "monitor",
 *   monitor_ids: [monitor.id],
 *   thresholds: [{ timeframe: "30d", target: 99.9 }],
 *   timeframe: "30d",
 *   target_threshold: 99.9,
 * });
 * ```
 */
export const ServiceLevelObjective = Resource<ServiceLevelObjective>(
  "Datadog.ServiceLevelObjective",
);

/** Raw SLO shape returned by the Datadog API (superset of Attributes). */
type SloResponse = ServiceLevelObjectiveAttributes & Record<string, unknown>;

const toAttributes = (s: SloResponse): ServiceLevelObjectiveAttributes => ({
  id: s.id,
  name: s.name,
  type: s.type,
  description: s.description,
  tags: s.tags,
  thresholds: s.thresholds,
  timeframe: s.timeframe,
  target_threshold: s.target_threshold,
  warning_threshold: s.warning_threshold,
  query: s.query,
  monitor_ids: s.monitor_ids,
  groups: s.groups,
  sli_specification: s.sli_specification,
  created_at: s.created_at,
  modified_at: s.modified_at,
});

const PAGE_SIZE = 1000;

export const ServiceLevelObjectiveProvider = () =>
  Provider.effect(
    ServiceLevelObjective,
    Effect.gen(function* () {
      const api = yield* Api;

      const getSlo = (id: string) =>
        api
          .request<{ data: SloResponse }>({
            method: "GET",
            path: `/api/v1/slo/${id}`,
            resource: `SLO ${id}`,
          })
          .pipe(Effect.map((res) => res.data));

      return {
        stables: ["id"],
        list: () =>
          Effect.gen(function* () {
            const all: ServiceLevelObjectiveAttributes[] = [];
            for (let offset = 0; ; offset += PAGE_SIZE) {
              const res = yield* api.request<{ data: SloResponse[] }>({
                method: "GET",
                path: "/api/v1/slo",
                resource: "SLOs",
                urlParams: { limit: PAGE_SIZE, offset },
              });
              all.push(...res.data.map(toAttributes));
              if (res.data.length < PAGE_SIZE) break;
            }
            return all;
          }),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.type !== output.type) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — the SLO id is server-assigned; probe with the cached
          // `output.id` and treat NotFound (deleted out-of-band) as "no
          // observed state" so we converge by re-creating.
          const observed =
            output?.id !== undefined
              ? yield* getSlo(output.id).pipe(
                  Effect.catchTag("Datadog.NotFound", () =>
                    Effect.succeed(undefined),
                  ),
                )
              : undefined;

          // Ensure — POST mints a new SLO with a fresh id. The response
          // wraps the created SLO in a one-element `data` array.
          if (observed === undefined) {
            const created = yield* api.request<{ data: SloResponse[] }>({
              method: "POST",
              path: "/api/v1/slo",
              resource: "SLO",
              body: news,
            });
            return toAttributes(created.data[0]);
          }

          // Sync — PUT replaces the SLO definition with the desired props.
          // `type` changes are replacement-only (handled in diff).
          const updated = yield* api.request<{ data: SloResponse[] }>({
            method: "PUT",
            path: `/api/v1/slo/${observed.id}`,
            resource: `SLO ${observed.id}`,
            body: news,
          });
          return toAttributes(updated.data[0]);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* api
            .request({
              method: "DELETE",
              path: `/api/v1/slo/${output.id}`,
              resource: `SLO ${output.id}`,
            })
            .pipe(Effect.catchTag("Datadog.NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (output?.id === undefined) return undefined;
          return yield* getSlo(output.id).pipe(
            Effect.map(toAttributes),
            Effect.catchTag("Datadog.NotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        }),
      };
    }),
  );
