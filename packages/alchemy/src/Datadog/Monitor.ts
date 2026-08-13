import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Api } from "./Api.ts";
import type { Providers } from "./Providers.ts";

/**
 * Datadog monitor types. `metric alert` and `query alert` are equivalent on
 * the Datadog side (the API normalizes between them), so switching between
 * those two updates in place; any other `type` change forces a replacement.
 */
export type MonitorType =
  | "metric alert"
  | "query alert"
  | "composite"
  | "event-v2 alert"
  | "log alert"
  | "process alert"
  | "rum alert"
  | "service check"
  | "slo alert"
  | "synthetics alert"
  | "trace-analytics alert"
  | "audit alert"
  | "ci-pipelines alert"
  | "ci-tests alert"
  | "error-tracking alert"
  | "database-monitoring alert"
  | "network-performance alert"
  | (string & {});

/**
 * Alert thresholds. Which fields apply depends on the monitor type and the
 * comparison operator in the query — `critical` should match the threshold
 * in the query string itself.
 */
export interface MonitorThresholds {
  /** The threshold that triggers the alert (must match the query). */
  critical?: number;
  /** The warning threshold. */
  warning?: number;
  /** Recovery threshold for the alert state. */
  critical_recovery?: number;
  /** Recovery threshold for the warning state. */
  warning_recovery?: number;
  /** Service-check monitors: the OK threshold. */
  ok?: number;
  /** Service-check monitors: the UNKNOWN threshold. */
  unknown?: number;
}

/**
 * Monitor options. Field names mirror the Datadog API (snake_case) verbatim
 * so values round-trip without translation.
 *
 * @see https://docs.datadoghq.com/api/latest/monitors/#create-a-monitor
 */
export interface MonitorOptions {
  /** Alert/warning/recovery thresholds. */
  thresholds?: MonitorThresholds;
  /** Notify when data stops reporting. @default false */
  notify_no_data?: boolean;
  /** Minutes before a monitor with `notify_no_data` alerts on missing data. */
  no_data_timeframe?: number | null;
  /**
   * How to evaluate missing data: `"default"`, `"show_no_data"`,
   * `"show_and_notify_no_data"`, `"resolve"`. Prefer this over
   * `notify_no_data` for newer monitor types.
   */
  on_missing_data?: string;
  /** Minutes before re-notifying on unresolved alerts. `null` disables. */
  renotify_interval?: number | null;
  /** Number of re-notifications (with `renotify_interval`). */
  renotify_occurrences?: number | null;
  /** States that trigger renotification, e.g. `["alert", "no data"]`. */
  renotify_statuses?: string[] | null;
  /** Message sent on escalation (with `renotify_interval`). */
  escalation_message?: string;
  /** Delay evaluation by N seconds (metrics with delayed ingestion). */
  evaluation_delay?: number | null;
  /** Seconds to wait before evaluating a new group, e.g. a fresh pod. */
  new_group_delay?: number | null;
  /** Hours after which the monitor auto-resolves. */
  timeout_h?: number | null;
  /** Require a full window of data before evaluating. @default false */
  require_full_window?: boolean;
  /** Tag alert events with `#audit`. @default false */
  notify_audit?: boolean;
  /** Append triggering tags to the notification title. @default true */
  include_tags?: boolean;
  /** A message to include with a re-notification. */
  notify_by?: string[];
  /** Notification presets: `"show_all"`, `"hide_query"`, `"hide_handles"`, `"hide_all"`. */
  notification_preset_name?: string;
  /** Turn scheduled downtimes red in the UI when the monitor would alert. */
  scheduling_options?: unknown;
  /** Groups to retain alert data for, e.g. `"3d"`. */
  group_retention_duration?: string;
}

/**
 * Desired state of a Datadog monitor. Field names mirror the Datadog API
 * (snake_case) verbatim.
 */
export interface MonitorProps {
  /** Name shown in the monitor list and notification titles. */
  name: string;
  /**
   * The monitor type. Changing it forces a replacement, except between the
   * equivalent `metric alert` / `query alert` pair.
   */
  type: MonitorType;
  /**
   * The monitor query, e.g.
   * `avg(last_5m):avg:trace.express.request.errors{env:prod}.as_rate() > 1`.
   * Syntax varies by monitor type.
   */
  query: string;
  /**
   * Notification message. Supports Datadog notification syntax —
   * `@slack-channel`, `@pagerduty-service`, template variables like
   * `{{value}}` / `{{host.name}}`, and conditionals.
   */
  message?: string;
  /** Tags applied to the monitor (`key:value` strings). */
  tags?: string[];
  /** Priority from 1 (critical) to 5 (informational). */
  priority?: number | null;
  /** Type-specific alerting options. */
  options?: MonitorOptions;
  /** Role UUIDs allowed to edit the monitor. */
  restricted_roles?: string[] | null;
}

/** Current state of a Datadog monitor, as returned by the API. */
export interface MonitorAttributes {
  /** Server-assigned monitor id. */
  id: number;
  name: string;
  type: MonitorType;
  query: string;
  message?: string;
  tags?: string[];
  priority?: number | null;
  options?: MonitorOptions;
  /** Whether the monitor evaluates per-group (multi-alert). */
  multi?: boolean;
  /** Current evaluation state, e.g. `"OK"`, `"Alert"`, `"No Data"`. */
  overall_state?: string;
  /** ISO timestamp of creation. */
  created?: string;
  /** ISO timestamp of last modification. */
  modified?: string;
}

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
 * `metric alert` / `query alert` pair); everything else updates in place.
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

/** Raw monitor shape returned by the Datadog API (superset of Attributes). */
type MonitorResponse = MonitorAttributes & Record<string, unknown>;

const toAttributes = (m: MonitorResponse): MonitorAttributes => ({
  id: m.id,
  name: m.name,
  type: m.type,
  query: m.query,
  message: m.message,
  tags: m.tags,
  priority: m.priority,
  options: m.options,
  multi: m.multi,
  overall_state: m.overall_state,
  created: m.created,
  modified: m.modified,
});

/**
 * `metric alert` and `query alert` are the same monitor type on the wire —
 * the API accepts either and may echo back the other — so a switch between
 * them is an in-place update, not a replacement.
 */
const sameMonitorType = (a: MonitorType, b: MonitorType) => {
  const canonical = (t: MonitorType) =>
    t === "metric alert" ? "query alert" : t;
  return canonical(a) === canonical(b);
};

const PAGE_SIZE = 100;

export const MonitorProvider = () =>
  Provider.effect(
    Monitor,
    Effect.gen(function* () {
      const api = yield* Api;

      const getMonitor = (id: number) =>
        api.request<MonitorResponse>({
          method: "GET",
          path: `/api/v1/monitor/${id}`,
          resource: `monitor ${id}`,
        });

      return {
        stables: ["id"],
        list: () =>
          Effect.gen(function* () {
            const all: MonitorAttributes[] = [];
            for (let page = 0; ; page++) {
              const batch = yield* api.request<MonitorResponse[]>({
                method: "GET",
                path: "/api/v1/monitor",
                resource: "monitors",
                urlParams: { page, page_size: PAGE_SIZE },
              });
              all.push(...batch.map(toAttributes));
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
          const observed =
            output?.id !== undefined
              ? yield* getMonitor(output.id).pipe(
                  Effect.catchTag("Datadog.NotFound", () =>
                    Effect.succeed(undefined),
                  ),
                )
              : undefined;

          // Ensure — POST mints a new monitor with a fresh id.
          if (observed === undefined) {
            return toAttributes(
              yield* api.request<MonitorResponse>({
                method: "POST",
                path: "/api/v1/monitor",
                resource: "monitor",
                body: news,
              }),
            );
          }

          // Sync — PUT replaces the monitor definition with the desired
          // props. `type` changes are replacement-only (handled in diff).
          return toAttributes(
            yield* api.request<MonitorResponse>({
              method: "PUT",
              path: `/api/v1/monitor/${observed.id}`,
              resource: `monitor ${observed.id}`,
              body: news,
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* api
            .request({
              method: "DELETE",
              path: `/api/v1/monitor/${output.id}`,
              resource: `monitor ${output.id}`,
            })
            .pipe(Effect.catchTag("Datadog.NotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (output?.id === undefined) return undefined;
          return yield* getMonitor(output.id).pipe(
            Effect.map(toAttributes),
            Effect.catchTag("Datadog.NotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        }),
      };
    }),
  );
