import * as DO from "@distilled.cloud/digitalocean";
import type { Alert } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { setEquals } from "../internal/equal.ts";
import { ignoreNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type UptimeAlertType = "latency" | "down" | "down_global" | "ssl_expiry";
export type UptimeAlertPeriod = "2m" | "3m" | "5m" | "10m" | "15m" | "30m" | "1h";

export type UptimeAlertNotifications = {
  /** Email addresses to notify. They must be verified on the team. */
  email?: string[];
  /** Slack incoming webhooks to post to. */
  slack?: Array<{ channel: string; url: string }>;
};

export type UptimeAlertProps = {
  /** The uptime check. A change replaces the alert. */
  checkId: string;
  /**
   * Display name. A change renames the alert in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /**
   * `down`: down from any region. `down_global`: down from every region.
   * `latency`: slower than `threshold` milliseconds. `ssl_expiry`: the
   * certificate expires within `threshold` days.
   */
  type: UptimeAlertType;
  /** Milliseconds for `latency`, days for `ssl_expiry`. */
  threshold?: number;
  /** How `threshold` is compared. @default "greater_than" */
  comparison?: "greater_than" | "less_than";
  /** How long the condition must hold before the alert fires. */
  period: UptimeAlertPeriod;
  /** Where to send the alert: at least one email address or Slack webhook. */
  notifications: UptimeAlertNotifications;
};

export type UptimeAlert = Resource<
  "DigitalOcean.Monitoring.UptimeAlert",
  UptimeAlertProps,
  {
    /** Alert id (UUID). */
    alertId: string;
    /** The uptime check. */
    checkId: string;
    /** Display name. */
    name: string;
    /** Alert type. */
    type: string;
  },
  never,
  Providers
>;

export type UptimeAlertAttributes = UptimeAlert["Attributes"];

/**
 * An alert on an `UptimeCheck`, sent by email or Slack when the target is
 * down, slow, or its certificate is about to expire. Every prop but
 * `checkId` updates in place.
 *
 * ### Alerting on a Check
 * **Example:** Downtime and certificate-expiry alerts
 * ```typescript
 * const check = yield* DigitalOcean.Monitoring.UptimeCheck("site", {
 *   type: "https",
 *   target: "https://example.com",
 * });
 * yield* DigitalOcean.Monitoring.UptimeAlert("site-down", {
 *   checkId: check.checkId,
 *   type: "down_global",
 *   period: "5m",
 *   notifications: { email: ["oncall@example.com"] },
 * });
 * yield* DigitalOcean.Monitoring.UptimeAlert("site-cert", {
 *   checkId: check.checkId,
 *   type: "ssl_expiry",
 *   threshold: 14,
 *   period: "1h",
 *   notifications: { email: ["oncall@example.com"] },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#operation/uptime_create_alert
 *
 * @resource
 * @product Monitoring
 * @category Observability
 */
export const UptimeAlert = Resource<UptimeAlert>("DigitalOcean.Monitoring.UptimeAlert");

const PAGE_SIZE = 200;

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 100 });

const toAttrs = (checkId: string, alert: Alert): UptimeAlertAttributes => ({
  alertId: alert.id,
  checkId,
  name: alert.name,
  type: alert.type,
});

// The uptime API answers a missing id with 403, typed as UptimeCheckNotFound.
const observeById = (checkId: string, alertId: string) =>
  DO.getUptimeAlert({ check_id: checkId, alert_id: alertId }).pipe(
    Effect.map((r) => Option.some(r.alert)),
    Effect.catchTag(["NotFound", "UptimeCheckNotFound"], () => Effect.succeedNone),
  );

const observeByName = (checkId: string, name: string) =>
  DO.listUptimeAlerts.items({ check_id: checkId, per_page: PAGE_SIZE }).pipe(
    Stream.filter((alert) => alert.name === name),
    Stream.runHead,
    Effect.catchTag(["NotFound", "UptimeCheckNotFound"], () => Effect.succeedNone),
  );

const observe = Effect.fn(function* (
  checkId: string,
  name: string,
  output: UptimeAlertAttributes | undefined,
) {
  if (output !== undefined) {
    const byId = yield* observeById(output.checkId, output.alertId);
    if (Option.isSome(byId)) return byId;
  }
  return yield* observeByName(checkId, name);
});

const desiredOf = (name: string, news: UptimeAlertProps) => ({
  name,
  type: news.type,
  threshold: news.threshold,
  comparison: news.comparison ?? "greater_than",
  period: news.period,
  notifications: {
    email: news.notifications.email ?? [],
    slack: news.notifications.slack ?? [],
  },
});

const isInSync = (alert: Alert, desired: ReturnType<typeof desiredOf>) =>
  alert.name === desired.name &&
  alert.type === desired.type &&
  (alert.threshold ?? undefined) === desired.threshold &&
  alert.comparison === desired.comparison &&
  alert.period === desired.period &&
  setEquals(alert.notifications.email, desired.notifications.email) &&
  setEquals(
    alert.notifications.slack.map((s) => `${s.channel}\0${s.url}`),
    desired.notifications.slack.map((s) => `${s.channel}\0${s.url}`),
  );

export const UptimeAlertProvider = () =>
  Provider.succeed(UptimeAlert, {
    stables: ["alertId", "checkId"],
    read: Effect.fn(function* ({ id, olds, output }) {
      const name = olds.name ?? (yield* physicalName(id));
      const observed = yield* observe(output?.checkId ?? olds.checkId, name, output);
      return Option.getOrUndefined(
        Option.map(observed, (alert) => toAttrs(output?.checkId ?? olds.checkId, alert)),
      );
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!("checkId" in news) || !isResolved(news.checkId) || news.checkId !== olds.checkId) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const desired = desiredOf(name, news);
      const observed = yield* observe(news.checkId, name, output);
      if (Option.isNone(observed)) {
        const { alert } = yield* DO.createUptimeAlert({ check_id: news.checkId, ...desired });
        return toAttrs(news.checkId, alert);
      }
      const alert = observed.value;
      if (isInSync(alert, desired)) return toAttrs(news.checkId, alert);
      const updated = yield* DO.updateUptimeAlert({
        check_id: news.checkId,
        alert_id: alert.id,
        ...desired,
      });
      return toAttrs(news.checkId, updated.alert);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        DO.deleteUptimeAlert({ check_id: output.checkId, alert_id: output.alertId }),
      ).pipe(Effect.catchTag("UptimeCheckNotFound", () => Effect.void));
    }),
  });
