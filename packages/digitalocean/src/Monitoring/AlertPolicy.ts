import * as DO from "@distilled.cloud/digitalocean";
import type { AlertPolicy as ApiAlertPolicy, AlertPolicyType } from "@distilled.cloud/digitalocean";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { setEquals } from "../internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type { AlertPolicyType } from "@distilled.cloud/digitalocean";

export type AlertPolicyProps = {
  /** The metric, for example `"v1/insights/droplet/cpu"` or `"v1/insights/droplet/memory_utilization_percent"`. */
  type: AlertPolicyType;
  /** Shown in the alert. */
  description: string;
  /** Fire when the metric is above or below `value`. */
  compare: "GreaterThan" | "LessThan";
  /** The threshold. */
  value: number;
  /** How long the condition must hold. */
  window: "5m" | "10m" | "30m" | "1h";
  /** Droplet ids to watch. */
  entities?: string[];
  /** Watch every droplet with one of these tags. */
  tags?: string[];
  /**
   * Email addresses (verified on the team) to notify. A policy needs at
   * least one email address or Slack webhook.
   */
  email?: string[];
  /** Slack incoming webhooks to post to. */
  slack?: Array<{ channel: string; url: string }>;
  /** @default true */
  enabled?: boolean;
};

export type AlertPolicy = Resource<
  "DigitalOcean.Monitoring.AlertPolicy",
  AlertPolicyProps,
  {
    /** Policy id (UUID). */
    alertPolicyId: string;
    /** The metric. */
    type: string;
    /** Whether the policy is enabled. */
    enabled: boolean;
  },
  never,
  Providers
>;

export type AlertPolicyAttributes = AlertPolicy["Attributes"];

/**
 * A DigitalOcean Monitoring alert policy: notifies when a droplet metric
 * (CPU, memory, disk, load, bandwidth) crosses a threshold for a while.
 * The droplets need `monitoring: true`. Every prop updates in place.
 *
 * A policy has no name or tags of its own, so Alchemy knows it only by the
 * id it recorded.
 *
 * ### Alerting on Droplet Metrics
 * **Example:** High CPU on every web droplet
 * ```typescript
 * yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 *   monitoring: true,
 *   tags: ["web"],
 * });
 * yield* DigitalOcean.Monitoring.AlertPolicy("web-cpu", {
 *   type: "v1/insights/droplet/cpu",
 *   description: "CPU above 80% for 5 minutes",
 *   compare: "GreaterThan",
 *   value: 80,
 *   window: "5m",
 *   tags: ["web"],
 *   email: ["oncall@example.com"],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Monitoring
 *
 * @resource
 * @product Monitoring
 * @category Observability
 */
export const AlertPolicy = Resource<AlertPolicy>("DigitalOcean.Monitoring.AlertPolicy");

const toAttrs = (policy: ApiAlertPolicy): AlertPolicyAttributes => ({
  alertPolicyId: policy.uuid,
  type: policy.type,
  enabled: policy.enabled,
});

const observe = (alertPolicyId: string) =>
  noneIfNotFound(
    DO.getMonitoringAlertPolicy({ alert_uuid: alertPolicyId }).pipe(Effect.map((r) => r.policy)),
  );

const desiredOf = (news: AlertPolicyProps) => ({
  type: news.type,
  description: news.description,
  compare: news.compare,
  value: news.value,
  window: news.window,
  entities: news.entities ?? [],
  tags: news.tags ?? [],
  enabled: news.enabled ?? true,
  alerts: { email: news.email ?? [], slack: news.slack ?? [] },
});

const slackKeys = (slack: ReadonlyArray<{ channel: string; url: string }>) =>
  slack.map((s) => `${s.channel}\0${s.url}`);

const isInSync = (policy: ApiAlertPolicy, desired: ReturnType<typeof desiredOf>) =>
  policy.type === desired.type &&
  policy.description === desired.description &&
  policy.compare === desired.compare &&
  policy.value === desired.value &&
  policy.window === desired.window &&
  policy.enabled === desired.enabled &&
  setEquals(policy.entities, desired.entities) &&
  setEquals(policy.tags, desired.tags) &&
  setEquals(policy.alerts.email, desired.alerts.email) &&
  setEquals(slackKeys(policy.alerts.slack), slackKeys(desired.alerts.slack));

export const AlertPolicyProvider = () =>
  Provider.succeed(AlertPolicy, {
    stables: ["alertPolicyId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      return Option.getOrUndefined(Option.map(yield* observe(output.alertPolicyId), toAttrs));
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const desired = desiredOf(news);
      const observed = output === undefined ? Option.none() : yield* observe(output.alertPolicyId);
      if (Option.isNone(observed)) {
        const { policy } = yield* DO.createMonitoringAlertPolicy(desired);
        return toAttrs(policy);
      }
      if (isInSync(observed.value, desired)) return toAttrs(observed.value);
      const updated = yield* DO.updateMonitoringAlertPolicy({
        alert_uuid: observed.value.uuid,
        ...desired,
      });
      return toAttrs(updated.policy);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteMonitoringAlertPolicy({ alert_uuid: output.alertPolicyId }));
    }),
  });
