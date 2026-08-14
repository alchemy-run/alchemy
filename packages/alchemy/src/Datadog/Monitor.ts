import * as Monitors from "@distilled.cloud/datadog/monitors";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * Desired state of a Datadog monitor — the Datadog `CreateMonitor` request
 * body verbatim (snake_case wire names), so any monitor built in the Datadog
 * UI's editor exports directly into these props.
 */
export type MonitorProps = Monitors.CreateMonitorRequest;

/** Current state of a Datadog monitor, as returned by the API. */
export type MonitorAttributes = Monitors.Monitor;

export type Monitor = Resource<
  "Datadog.Monitor",
  MonitorProps,
  MonitorAttributes,
  never,
  Providers
>;

/**
 * A Datadog monitor — a continuously evaluated query over metrics, traces,
 * logs, or other telemetry that alerts (via `message` `@-handles`) when its
 * condition is met.
 *
 * Props mirror the [Datadog Monitors API](https://docs.datadoghq.com/api/latest/monitors/)
 * verbatim (snake_case), so any query you build in the Datadog UI's monitor
 * editor can be exported and used here directly.
 *
 * Changing `type` triggers a replacement (except between the equivalent
 * `metric alert` / `query alert` pair, which Datadog normalizes between);
 * everything else updates in place.
 * @resource
 * @see https://docs.datadoghq.com/monitors/
 *
 * @section Monitoring service endpoints (APM)
 * @example Error rate on a tRPC endpoint
 * ```typescript
 * yield* Datadog.Monitor("checkout-errors", {
 *   name: "tRPC checkout.create error rate",
 *   type: "query alert",
 *   query:
 *     "sum(last_10m):sum:trace.express.request.errors{env:prod,resource_name:checkout.create}.as_count() / sum:trace.express.request.hits{env:prod,resource_name:checkout.create}.as_count() > 0.05",
 *   message: "checkout.create is failing for >5% of requests. @slack-alerts",
 *   tags: ["service:api", "team:payments"],
 *   priority: 2,
 *   options: {
 *     thresholds: { critical: 0.05, warning: 0.01 },
 *     notify_no_data: false,
 *   },
 * });
 * ```
 *
 * @example p95 latency on a tRPC endpoint
 * ```typescript
 * yield* Datadog.Monitor("checkout-latency", {
 *   name: "tRPC checkout.create p95 latency",
 *   type: "query alert",
 *   query:
 *     "percentile(last_10m):p95:trace.express.request{env:prod,resource_name:checkout.create} > 2",
 *   message: "p95 latency for checkout.create exceeded 2s. @pagerduty-api",
 *   tags: ["service:api", "team:payments"],
 *   options: {
 *     thresholds: { critical: 2, warning: 1 },
 *     evaluation_delay: 60,
 *   },
 * });
 * ```
 *
 * @section Infrastructure and workflows
 * @example Background job failures from logs
 * ```typescript
 * yield* Datadog.Monitor("sync-workflow-failures", {
 *   name: "Nightly sync workflow failures",
 *   type: "log alert",
 *   query:
 *     'logs("service:worker status:error @workflow:nightly-sync").index("*").rollup("count").last("30m") > 0',
 *   message: "The nightly sync workflow is failing. @slack-oncall",
 *   tags: ["service:worker"],
 *   options: { thresholds: { critical: 0 } },
 * });
 * ```
 */
export const Monitor = Resource<Monitor>("Datadog.Monitor");

/**
 * `metric alert` and `query alert` are the same monitor type on the wire —
 * the API accepts either and may echo back the other — so a switch between
 * them is an in-place update, not a replacement.
 */
const sameMonitorType = (a: string | undefined, b: string | undefined) => {
  const canonical = (t: string | undefined) =>
    t === "metric alert" ? "query alert" : t;
  return canonical(a) === canonical(b);
};

const PAGE_SIZE = 100;

export const MonitorProvider = () =>
  Provider.effect(
    Monitor,
    Effect.gen(function* () {
      const create = yield* Monitors.createMonitor;
      const update = yield* Monitors.updateMonitor;
      const get = yield* Monitors.getMonitor;
      const list = yield* Monitors.listMonitors;
      const del = yield* Monitors.deleteMonitor;

      return {
        stables: ["id"],
        // Enumerate every monitor in the org. `page`/`page_size` paginate;
        // each row is the same Monitor shape `read` produces, so it's
        // directly usable by `delete` with no follow-up get.
        list: () =>
          Effect.gen(function* () {
            const all: MonitorAttributes[] = [];
            for (let page = 0; ; page++) {
              const batch = yield* list({ page, page_size: PAGE_SIZE });
              all.push(...batch);
              if (batch.length < PAGE_SIZE) break;
            }
            return all;
          }),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && !sameMonitorType(news.type, output.type)) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — Datadog assigns the monitor id server-side, so the only
          // handle to a previously-created monitor is the cached `output.id`.
          // Treat NotFound (deleted out-of-band) as "no observed state" so we
          // converge by re-creating.
          const existingId = output?.id;
          const observed =
            existingId !== undefined
              ? yield* get({ monitor_id: existingId }).pipe(
                  Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
                )
              : undefined;

          // Ensure — POST mints a new monitor with a fresh id.
          if (existingId === undefined || observed === undefined) {
            return yield* create(news);
          }

          // Sync — PUT replaces the monitor definition with the desired
          // props. `type` changes are replacement-only (handled in diff).
          return yield* update({ ...news, monitor_id: existingId });
        }),
        delete: Effect.fn(function* ({ output }) {
          if (output.id === undefined) return;
          yield* del({ monitor_id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (output?.id === undefined) return undefined;
          return yield* get({ monitor_id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
