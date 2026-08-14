import * as Slos from "@distilled.cloud/datadog/service_level_objectives";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * Desired state of a Datadog Service Level Objective — the Datadog
 * `CreateSLO` request body verbatim (snake_case wire names).
 */
export type ServiceLevelObjectiveProps = Slos.CreateSLORequest;

/**
 * Current state of a Datadog SLO, as returned by the API. `SLOResponseData`
 * is the get-response shape — the create/update/list `ServiceLevelObjective`
 * shape narrows into it (same fields, some required there).
 */
export type ServiceLevelObjectiveAttributes = Slos.SLOResponseData;

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
 * verbatim (snake_case). Three SLO `type`s are supported:
 *
 * - **`metric`** — computed from a good-events / total-events metric query
 *   pair (count-based).
 * - **`monitor`** — uptime of one or more existing monitors (time-based).
 * - **`time_slice`** — percentage of time slices where a metric condition
 *   holds (time-based, no monitor required).
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
 *             data_source: "metrics",
 *             name: "query1",
 *             query: "p95:trace.express.request{env:prod,resource_name:checkout.create}",
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

const PAGE_SIZE = 1000;

export const ServiceLevelObjectiveProvider = () =>
  Provider.effect(
    ServiceLevelObjective,
    Effect.gen(function* () {
      const create = yield* Slos.createSLO;
      const update = yield* Slos.updateSLO;
      const get = yield* Slos.getSLO;
      const list = yield* Slos.listSLOs;
      const del = yield* Slos.deleteSLO;

      // Create/update responses wrap the affected SLOs in a one-element
      // `data` array; an empty array on a 200 would be an API contract
      // violation, surfaced as a plain failure rather than silently
      // persisting attributes with no id.
      const single = (
        res: Slos.SLOListResponse,
        operation: string,
      ): Effect.Effect<Slos.ServiceLevelObjective, Error> => {
        const slo = res.data?.[0];
        return slo === undefined
          ? Effect.fail(
              new Error(`Datadog returned an empty SLO ${operation} response`),
            )
          : Effect.succeed(slo);
      };

      return {
        stables: ["id"],
        // Enumerate every SLO in the org. `limit`/`offset` paginate; each row
        // is the same shape `read` produces.
        list: () =>
          Effect.gen(function* () {
            const all: ServiceLevelObjectiveAttributes[] = [];
            for (let offset = 0; ; offset += PAGE_SIZE) {
              const res = yield* list({ limit: PAGE_SIZE, offset });
              const batch = res.data ?? [];
              all.push(...batch);
              if (batch.length < PAGE_SIZE) break;
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
          const existingId = output?.id;
          const observed =
            existingId !== undefined
              ? yield* get({ slo_id: existingId }).pipe(
                  Effect.map((res) => res.data),
                  Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
                )
              : undefined;

          // Ensure — POST mints a new SLO with a fresh id.
          if (existingId === undefined || observed === undefined) {
            return yield* create(news).pipe(
              Effect.flatMap((res) => single(res, "create")),
            );
          }

          // Sync — PUT replaces the SLO definition with the desired props.
          // `type` changes are replacement-only (handled in diff).
          return yield* update({ ...news, slo_id: existingId }).pipe(
            Effect.flatMap((res) => single(res, "update")),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.id === undefined) return;
          yield* del({ slo_id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (output?.id === undefined) return undefined;
          return yield* get({ slo_id: output.id }).pipe(
            Effect.map((res) => res.data),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
