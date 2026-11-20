import * as DO from "@distilled.cloud/digitalocean";
import type { AlertRule as ApiAlertRule } from "@distilled.cloud/digitalocean";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type ThresholdOperator =
  | "THRESHOLD_OPERATOR_EQUAL"
  | "THRESHOLD_OPERATOR_NOT_EQUAL"
  | "THRESHOLD_OPERATOR_LESS_THAN"
  | "THRESHOLD_OPERATOR_LESS_THAN_OR_EQUAL"
  | "THRESHOLD_OPERATOR_GREATER_THAN"
  | "THRESHOLD_OPERATOR_GREATER_THAN_OR_EQUAL";

export type AlertRuleProps = {
  /**
   * Rule name. Updates in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Dotted OpenTelemetry metric name, for example `do.droplets.cpu_utilization`. */
  metric: string;
  /** URNs of the resources the rule watches, for example a Droplet's `urn`. */
  resourceUrns?: string[];
  /** Resource tags that select what the rule watches. */
  tags?: string[];
  /** Label filters on the metric. */
  filters?: { field: string; operator: DO.QueryFilterOperator; value: string }[];
  /** Evaluation window. @default "EVALUATION_WINDOW_5M" */
  window?: DO.AlertConditionWindow;
  /** Thresholds; set `warning`, `critical`, or both. */
  thresholds: { operator: ThresholdOperator; warning?: number; critical?: number };
  /** Notification channels, and which severities each one receives. */
  notify: { channelId: string; on?: ("SEVERITY_WARNING" | "SEVERITY_CRITICAL")[] }[];
  /** Wait before notifying again for a still-firing alert. @default "RE_ALERT_DURATION_4H" */
  reAlert?: DO.AlertRuleSpecReAlertDuration;
  /** Whether the rule is evaluated. @default true */
  enabled?: boolean;
};

export type AlertRule = Resource<
  "DigitalOcean.Insights.AlertRule",
  AlertRuleProps,
  {
    /** Rule id. */
    alertRuleId: string;
    /** Rule name. */
    name: string;
    /** `ALERT_RULE_STATUS_ACTIVE` or `ALERT_RULE_STATUS_PAUSED`. */
    status: string;
  },
  never,
  Providers
>;

export type AlertRuleAttributes = AlertRule["Attributes"];

/**
 * An Insights alert rule: a metric query, thresholds, and the channels to
 * notify when the metric crosses them. Every field updates in place.
 *
 * ### Alerting on a Metric
 * **Example:** CPU above 80% on one Droplet
 * ```typescript
 * const oncall = yield* DigitalOcean.Insights.NotificationChannel("oncall", {
 *   email: { to: "oncall@example.com" },
 * });
 * yield* DigitalOcean.Insights.AlertRule("high-cpu", {
 *   metric: "do.droplets.cpu_utilization",
 *   resourceUrns: [host.urn],
 *   thresholds: { operator: "THRESHOLD_OPERATOR_GREATER_THAN", warning: 80, critical: 95 },
 *   notify: [{ channelId: oncall.channelId }],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Insights
 *
 * @resource
 * @product Insights
 * @category Observability
 */
export const AlertRule = Resource<AlertRule>("DigitalOcean.Insights.AlertRule");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const specOf = (name: string, props: AlertRuleProps) => ({
  name,
  query: {
    metric: props.metric,
    resource_urns: props.resourceUrns,
    tags: props.tags,
    filters: props.filters,
  },
  condition: { window: props.window ?? "EVALUATION_WINDOW_5M" },
  thresholds: props.thresholds,
  notification_channels: props.notify.map((n) => ({
    notification_channel_id: n.channelId,
    notify_on: n.on,
  })),
  re_alert_duration: props.reAlert ?? "RE_ALERT_DURATION_4H",
});

const statusOf = (props: AlertRuleProps) =>
  props.enabled === false ? "ALERT_RULE_STATUS_PAUSED" : "ALERT_RULE_STATUS_ACTIVE";

const toAttrs = (rule: ApiAlertRule): AlertRuleAttributes => ({
  alertRuleId: rule.id,
  name: rule.spec.name,
  status: rule.status,
});

const observe = (id: string) =>
  noneIfNotFound(DO.getInsightAlertRule({ id }).pipe(Effect.map((r) => r.alert_rule)));

// Compare what the API echoes back, ignoring members it fills in.
const sameSpec = (observed: ApiAlertRule, desired: ReturnType<typeof specOf>) => {
  const o = observed.spec;
  return (
    o.name === desired.name &&
    o.query.metric === desired.query.metric &&
    JSON.stringify(o.query.resource_urns ?? []) ===
      JSON.stringify(desired.query.resource_urns ?? []) &&
    JSON.stringify(o.query.tags ?? []) === JSON.stringify(desired.query.tags ?? []) &&
    JSON.stringify(o.query.filters ?? []) === JSON.stringify(desired.query.filters ?? []) &&
    o.condition?.window === desired.condition.window &&
    JSON.stringify(o.thresholds) === JSON.stringify(desired.thresholds) &&
    JSON.stringify((o.notification_channels ?? []).map((n) => n.notification_channel_id).sort()) ===
      JSON.stringify(desired.notification_channels.map((n) => n.notification_channel_id).sort()) &&
    o.re_alert_duration === desired.re_alert_duration
  );
};

export const AlertRuleProvider = () =>
  Provider.succeed(AlertRule, {
    stables: ["alertRuleId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.alertRuleId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const spec = specOf(name, news);
      const status = statusOf(news);
      const observed =
        output === undefined ? Option.none<ApiAlertRule>() : yield* observe(output.alertRuleId);
      if (Option.isNone(observed)) {
        const { alert_rule } = yield* DO.createInsightAlertRule({ spec, status });
        return toAttrs(alert_rule);
      }
      if (sameSpec(observed.value, spec) && observed.value.status === status) {
        return toAttrs(observed.value);
      }
      const { alert_rule } = yield* DO.updateInsightAlertRule({
        id: observed.value.id,
        spec,
        status,
      });
      return toAttrs(alert_rule);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteInsightAlertRule({ id: output.alertRuleId }));
    }),
  });
