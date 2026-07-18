import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { LogGroupName } from "./LogGroup.ts";

export interface MetricFilterProps {
  /**
   * Name of the log group the filter reads from, e.g. `/my-app/cluster`.
   */
  logGroupName: LogGroupName;
  /**
   * Name of the filter — the idempotency key within the log group.
   */
  filterName: string;
  /**
   * CloudWatch Logs filter pattern. Matching log events increment the
   * metric, e.g. `?"ConfigError" ?"Essential container in task exited"`
   * (an OR of terms).
   */
  filterPattern: string;
  /**
   * Namespace of the metric emitted for matching log events, e.g.
   * `MyApp/Cluster`.
   */
  metricNamespace: string;
  /**
   * Name of the metric emitted for matching log events, e.g.
   * `BootFailures`.
   */
  metricName: string;
  /**
   * Value emitted per match (a CloudWatch Logs metric-value expression).
   * @default "1"
   */
  metricValue?: string;
  /**
   * Value emitted for periods with no match. Set this so the metric
   * reports 0 instead of going absent, which lets an alarm evaluate
   * `TreatMissingData: notBreaching` reliably.
   */
  defaultValue?: number;
}

export interface MetricFilter extends Resource<
  "AWS.Logs.MetricFilter",
  MetricFilterProps,
  {
    logGroupName: LogGroupName;
    filterName: string;
    filterPattern: string;
    metricNamespace: string;
    metricName: string;
    metricValue: string;
    defaultValue?: number;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Logs metric filter — turns matching log lines in a
 * {@link LogGroup} into a custom CloudWatch metric that an
 * {@link Alarm} can watch.
 *
 * `PutMetricFilter` is an idempotent upsert keyed by
 * `(logGroupName, filterName)`, so reconcile handles both create and
 * update in place. Renaming the filter or moving it to a different log
 * group replaces it, since the old filter has to be deleted from its old
 * log group.
 *
 * @resource
 * @section Alerting on a Crash Loop
 * @example Turn Boot Failures Into a Metric
 * ```typescript
 * const taskLogs = yield* LogGroup("TaskLogs", { retentionInDays: 14 });
 *
 * const bootFailures = yield* MetricFilter("BootFailures", {
 *   logGroupName: taskLogs.logGroupName,
 *   filterName: "boot-failures",
 *   // Matches either term in a log line emitted with no metric of its own.
 *   filterPattern: '?"ConfigError" ?"Essential container in task exited"',
 *   metricNamespace: "MyApp/Cluster",
 *   metricName: "BootFailures",
 *   // Report 0 (not absent) for quiet periods so the alarm evaluates cleanly.
 *   defaultValue: 0,
 * });
 * ```
 *
 * @example Alarm on the Emitted Metric
 * ```typescript
 * const alarm = yield* Alarm("BootFailureAlarm", {
 *   metricName: bootFailures.metricName,
 *   namespace: bootFailures.metricNamespace,
 *   statistic: "Sum",
 *   period: 300,
 *   evaluationPeriods: 1,
 *   threshold: 1,
 *   comparisonOperator: "GreaterThanOrEqualToThreshold",
 *   treatMissingData: "notBreaching",
 *   alarmActions: [snsTopic.arn],
 * });
 * ```
 */
export const MetricFilter = Resource<MetricFilter>("AWS.Logs.MetricFilter");

export const MetricFilterProvider = () =>
  Provider.effect(
    MetricFilter,
    Effect.gen(function* () {
      const findFilter = Effect.fn(function* (
        logGroupName: string,
        filterName: string,
      ) {
        // `describeMetricFilters` filtered by name prefix reports nothing
        // for a missing filter — no not-found fault, just an empty array.
        const response = yield* logs.describeMetricFilters({
          logGroupName,
          filterNamePrefix: filterName,
        });
        return (response.metricFilters ?? []).find(
          (filter) => filter.filterName === filterName,
        );
      });

      return {
        stables: ["logGroupName", "filterName"],
        // Account/region collection: paginate `describeMetricFilters`
        // across every log group (unscoped by `logGroupName`) exhaustively.
        list: () =>
          logs.describeMetricFilters.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.metricFilters ?? [])
                .filter(
                  (
                    filter,
                  ): filter is logs.MetricFilter & {
                    logGroupName: string;
                    filterName: string;
                    filterPattern: string;
                    metricTransformations: logs.MetricTransformation[];
                  } =>
                    filter.logGroupName != null &&
                    filter.filterName != null &&
                    filter.filterPattern != null &&
                    (filter.metricTransformations?.length ?? 0) > 0,
                )
                .map((filter) => {
                  const transformation = filter.metricTransformations[0]!;
                  return {
                    logGroupName: filter.logGroupName,
                    filterName: filter.filterName,
                    filterPattern: filter.filterPattern,
                    metricNamespace: transformation.metricNamespace,
                    metricName: transformation.metricName,
                    metricValue: transformation.metricValue,
                    defaultValue: transformation.defaultValue,
                  };
                }),
            ),
          ),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // Keyed by (logGroupName, filterName); changing either is a
          // replace — the old filter must be deleted from its old log group.
          if (
            olds &&
            (olds.logGroupName !== news.logGroupName ||
              olds.filterName !== news.filterName)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const logGroupName = output?.logGroupName ?? olds?.logGroupName;
          const filterName = output?.filterName ?? olds?.filterName;
          if (!logGroupName || !filterName) return undefined;
          const filter = yield* findFilter(logGroupName, filterName);
          if (!filter) return undefined;
          const transformation = filter.metricTransformations?.[0];
          if (!transformation) return undefined;
          return {
            logGroupName: filter.logGroupName ?? logGroupName,
            filterName: filter.filterName ?? filterName,
            filterPattern: filter.filterPattern ?? "",
            metricNamespace: transformation.metricNamespace,
            metricName: transformation.metricName,
            metricValue: transformation.metricValue,
            defaultValue: transformation.defaultValue,
          };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          // Idempotent upsert (create AND update), keyed by
          // (logGroupName, filterName).
          const metricValue = news.metricValue ?? "1";
          yield* logs.putMetricFilter({
            logGroupName: news.logGroupName,
            filterName: news.filterName,
            filterPattern: news.filterPattern,
            metricTransformations: [
              {
                metricName: news.metricName,
                metricNamespace: news.metricNamespace,
                metricValue,
                defaultValue: news.defaultValue,
              },
            ],
          });
          yield* session.note(news.filterName);
          return {
            logGroupName: news.logGroupName,
            filterName: news.filterName,
            filterPattern: news.filterPattern,
            metricNamespace: news.metricNamespace,
            metricName: news.metricName,
            metricValue,
            defaultValue: news.defaultValue,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .deleteMetricFilter({
              logGroupName: output.logGroupName,
              filterName: output.filterName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
