import {
  type BillingAlert,
  GetBillingAlerts,
  GetBillingAlertsId,
  PostBillingAlerts,
  PostBillingAlertsIdActivate,
  PostBillingAlertsIdArchive,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** The kind of alert. Stripe currently only supports usage thresholds. */
export type AlertType = "usage_threshold";

/** How often an alert may fire. Stripe currently only supports one-time. */
export type AlertRecurrence = "one_time";

/** Lifecycle state of an alert. `archived` is terminal and irreversible. */
export type AlertStatus = "active" | "archived" | "inactive";

/** Narrows an alert to a subset of usage. At most one filter is allowed. */
export type AlertFilter = {
  /**
   * What the filter matches on. Stripe currently only supports `customer`.
   *
   * @default "customer"
   */
  type?: "customer";
  /**
   * Restrict the alert to this Stripe Customer ID, e.g. `cus_…`.
   */
  customer?: string;
};

/** The threshold configuration monitored by a `usage_threshold` alert. */
export type AlertUsageThreshold = {
  /**
   * The {@link Meter} ID whose usage is monitored, e.g. `mtr_…`. Pass a
   * meter's `meterId` attribute to wire the two together.
   */
  meter: string;
  /**
   * The value at which the alert fires — it triggers once usage on the
   * meter is greater than or equal to this number.
   */
  gte: number;
  /**
   * How the alert behaves once triggered.
   *
   * @default "one_time"
   */
  recurrence?: AlertRecurrence;
  /**
   * Limit the scope of the alert. Stripe accepts at most one filter.
   *
   * @default undefined - the alert covers all usage on the meter
   */
  filters?: AlertFilter[];
};

export type AlertProps = {
  /**
   * Title of the alert, shown in the Stripe dashboard. Cannot be changed
   * after creation — a change replaces the alert.
   *
   * @default - the resource's logical ID
   */
  title?: string;
  /**
   * The kind of alert to create. Stripe currently only supports
   * `usage_threshold`. Cannot be changed after creation.
   *
   * @default "usage_threshold"
   */
  alertType?: AlertType;
  /**
   * The threshold to monitor. Cannot be changed after creation — a change
   * to any field here replaces the alert.
   */
  usageThreshold: AlertUsageThreshold;
};

export type Alert = Resource<
  "Stripe.Alert",
  AlertProps,
  {
    /** Stripe's unique identifier for the alert, e.g. `alrt_…`. */
    alertId: string;
    /** The alert's dashboard title. */
    title: string;
    /** The kind of alert. */
    alertType: string;
    /**
     * Lifecycle state as last observed. `undefined` when Stripe reports no
     * status for the alert.
     */
    status: AlertStatus | undefined;
    /** `true` when the alert lives in live mode rather than test mode. */
    livemode: boolean;
    /** The observed threshold configuration. */
    usageThreshold:
      | {
          /** The monitored meter's ID. */
          meterId: string;
          /** The value at which the alert fires. */
          gte: number;
          /** How the alert behaves once triggered. */
          recurrence: string;
          /** The observed filters, normalised to plain IDs. */
          filters: {
            /** What the filter matches on. */
            type: string;
            /** The Customer ID the alert is limited to, if any. */
            customer: string | undefined;
          }[];
        }
      | undefined;
  },
  never,
  Providers
>;

type AlertAttributes = Alert["Attributes"];

/**
 * A Stripe Billing Alert — fires when usage recorded on a {@link Meter}
 * crosses a threshold, so you can notify a customer (or yourself) before a
 * bill surprises anyone.
 *
 * Alerts are **fully immutable**. Stripe exposes no update endpoint at all:
 * the only mutations are activate, deactivate and archive. Every property
 * on this resource therefore plans a `replace` when it changes — including
 * `title`, which reads like a cosmetic field but is not editable.
 *
 * Alerts also have **no `metadata` field**, so Alchemy cannot brand them the
 * way it brands other Stripe objects. After state loss, `read` re-discovers
 * the alert by listing alerts for the same meter and matching on the natural
 * key `(title, meter, gte)`. If two alerts in the account share all three,
 * the first match wins.
 *
 * :::caution
 * Stripe does not support deleting an alert. Destroying this resource
 * archives it (`POST /v1/billing/alerts/{id}/archive`), which removes it
 * from the dashboard list view and from `GET /v1/billing/alerts`. Archiving
 * is **non-reversible** — a subsequent deploy creates a brand new alert
 * rather than resurrecting the archived one. The delete is idempotent: an
 * already-archived or already-missing alert is treated as success.
 * :::
 *
 * ### Creating an Alert
 * **Example:** Alert when a meter crosses 10,000 units
 * ```typescript
 * const meter = yield* Stripe.Meter("api-requests", {
 *   eventName: "api_requests",
 * });
 *
 * const alert = yield* Stripe.Alert("api-requests-alert", {
 *   usageThreshold: {
 *     meter: meter.meterId,
 *     gte: 10_000,
 *   },
 * });
 * ```
 *
 * **Example:** Alert with an explicit title and recurrence
 * ```typescript
 * const alert = yield* Stripe.Alert("tokens-alert", {
 *   title: "Token usage over 1M",
 *   alertType: "usage_threshold",
 *   usageThreshold: {
 *     meter: meter.meterId,
 *     gte: 1_000_000,
 *     recurrence: "one_time",
 *   },
 * });
 * ```
 *
 * ### Scoping an Alert to one customer
 * **Example:** Only alert on a single customer's usage
 * ```typescript
 * const alert = yield* Stripe.Alert("acme-overage", {
 *   title: "Acme over 10k requests",
 *   usageThreshold: {
 *     meter: meter.meterId,
 *     gte: 10_000,
 *     filters: [{ type: "customer", customer: "cus_123" }],
 *   },
 * });
 * ```
 *
 * ### Composing meters and alerts
 * **Example:** A meter plus a ladder of thresholds
 * ```typescript
 * const meter = yield* Stripe.Meter("bytes-egressed", {
 *   eventName: "bytes_egressed",
 *   defaultAggregation: { formula: "sum" },
 *   valueSettings: { eventPayloadKey: "bytes" },
 * });
 *
 * const soft = yield* Stripe.Alert("egress-soft", {
 *   title: "Egress over 100GB",
 *   usageThreshold: { meter: meter.meterId, gte: 100_000_000_000 },
 * });
 *
 * const hard = yield* Stripe.Alert("egress-hard", {
 *   title: "Egress over 500GB",
 *   usageThreshold: { meter: meter.meterId, gte: 500_000_000_000 },
 * });
 *
 * return { soft: soft.alertId, hard: hard.alertId };
 * ```
 *
 * @see https://docs.stripe.com/api/billing/alert
 *
 * @resource
 */
export const Alert = Resource<Alert>("Stripe.Alert");

const DEFAULT_ALERT_TYPE: AlertType = "usage_threshold";
const DEFAULT_RECURRENCE: AlertRecurrence = "one_time";
const DEFAULT_FILTER_TYPE = "customer";
/** Hard bound on list pagination so a bad cursor can never spin forever. */
const MAX_PAGES = 50;

export const AlertProvider = () =>
  Provider.succeed(Alert, {
    stables: ["alertId", "title", "alertType", "livemode"],
    /**
     * Archived alerts drop out of `GET /v1/billing/alerts` entirely, so this
     * listing naturally converges for `alchemy unsafe nuke` even though the
     * objects are never truly deleted.
     */
    list: Effect.fn(function* () {
      const alerts = yield* listAlerts();
      return alerts.map(alertAttributes);
    }),
    diff: Effect.fn(function* ({ id, news, output }) {
      // `news` is `Input<Props>` during plan — bail out until it resolves.
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // Stripe has no update endpoint for alerts: every field is immutable,
      // so any change at all is a replacement.
      if ((news.title ?? id) !== output.title) {
        return { action: "replace" } as const;
      }
      if ((news.alertType ?? DEFAULT_ALERT_TYPE) !== output.alertType) {
        return { action: "replace" } as const;
      }
      const observed = output.usageThreshold;
      if (observed === undefined) return { action: "replace" } as const;
      if (news.usageThreshold.meter !== observed.meterId) {
        return { action: "replace" } as const;
      }
      if (news.usageThreshold.gte !== observed.gte) {
        return { action: "replace" } as const;
      }
      if (
        (news.usageThreshold.recurrence ?? DEFAULT_RECURRENCE) !==
        observed.recurrence
      ) {
        return { action: "replace" } as const;
      }
      if (!filtersEqual(news.usageThreshold.filters ?? [], observed.filters)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.alertId) {
        const observed = yield* getAlert(output.alertId);
        // Archiving is irreversible and hides the alert from the API, so an
        // archived alert is "gone" as far as the engine is concerned.
        if (observed && observed.status !== "archived") {
          return alertAttributes(observed);
        }
      }
      // State loss: alerts carry no metadata, so fall back to the natural
      // key `(title, meter, gte)` scoped to the meter.
      if (!olds?.usageThreshold) return undefined;
      const observed = yield* findAlert(
        olds.title ?? id,
        olds.usageThreshold.meter,
        olds.usageThreshold.gte,
      );
      return observed ? alertAttributes(observed) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const title = news.title ?? id;

      // 1. Observe — the cached id first, treating an archived alert as
      //    absent, then the natural key so a create whose state write failed
      //    is adopted rather than duplicated.
      let observed = output?.alertId
        ? yield* getAlert(output.alertId)
        : undefined;
      if (observed?.status === "archived") observed = undefined;
      if (observed === undefined) {
        observed = yield* findAlert(
          title,
          news.usageThreshold.meter,
          news.usageThreshold.gte,
        );
      }

      // 2. Ensure — create when genuinely missing. There is nothing to
      //    update afterwards: Stripe exposes no alert update endpoint.
      if (observed === undefined) {
        observed = yield* PostBillingAlerts({
          alert_type: news.alertType ?? DEFAULT_ALERT_TYPE,
          title,
          usage_threshold: {
            meter: news.usageThreshold.meter,
            gte: news.usageThreshold.gte,
            recurrence: news.usageThreshold.recurrence ?? DEFAULT_RECURRENCE,
            ...(news.usageThreshold.filters !== undefined
              ? {
                  filters: news.usageThreshold.filters.map((filter) => ({
                    type: filter.type ?? DEFAULT_FILTER_TYPE,
                    ...(filter.customer !== undefined
                      ? { customer: filter.customer }
                      : {}),
                  })),
                }
              : {}),
          },
        });
      }

      // 3. Sync — the desired state of a deployed alert is "active", so an
      //    alert someone deactivated out of band is reactivated.
      if (observed.status === "inactive") {
        observed = yield* PostBillingAlertsIdActivate({ id: observed.id });
      }

      return alertAttributes(observed);
    }),
    /**
     * Stripe has no delete endpoint for alerts — destroying this resource
     * archives it instead. Idempotent: an already-archived or
     * already-missing alert is a no-op.
     */
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* getAlert(output.alertId);
      if (observed === undefined || observed.status === "archived") return;
      yield* PostBillingAlertsIdArchive({ id: output.alertId }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (error) =>
          error.code === "resource_missing" ? Effect.void : Effect.fail(error),
        ),
      );
    }),
  });

/** Map a Stripe `billing.alert` onto this resource's Attributes shape. */
const alertAttributes = (alert: BillingAlert): AlertAttributes => ({
  alertId: alert.id,
  title: alert.title,
  alertType: alert.alert_type,
  status: alert.status ?? undefined,
  livemode: alert.livemode,
  usageThreshold: alert.usage_threshold
    ? {
        meterId: meterIdOf(alert.usage_threshold.meter),
        gte: alert.usage_threshold.gte,
        recurrence: alert.usage_threshold.recurrence,
        filters: (alert.usage_threshold.filters ?? []).map((filter) => ({
          type: filter.type,
          customer: customerIdOf(filter.customer),
        })),
      }
    : undefined,
});

/** `usage_threshold.meter` is expandable — normalise it back to an ID. */
const meterIdOf = (meter: string | { readonly id: string }): string =>
  typeof meter === "string" ? meter : meter.id;

/** `filters[].customer` is expandable — normalise it back to an ID. */
const customerIdOf = (
  customer: string | { readonly id: string } | null,
): string | undefined => {
  if (customer === null) return undefined;
  return typeof customer === "string" ? customer : customer.id;
};

/** Structural comparison of desired filters against observed filters. */
const filtersEqual = (
  desired: readonly AlertFilter[],
  observed: readonly { type: string; customer: string | undefined }[],
): boolean => {
  if (desired.length !== observed.length) return false;
  return desired.every((filter, index) => {
    const other = observed[index];
    if (other === undefined) return false;
    return (
      (filter.type ?? DEFAULT_FILTER_TYPE) === other.type &&
      filter.customer === other.customer
    );
  });
};

/**
 * Fetch an alert by id, mapping "no such object" onto `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing`, and distilled dispatches on `error.type` before HTTP
 * status — so the miss can surface as either `NotFound` or
 * `InvalidRequestError` depending on the response shape. Both are handled.
 */
const getAlert = (alertId: string) =>
  GetBillingAlertsId({ id: alertId }).pipe(
    Effect.map((alert): BillingAlert | undefined => alert),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/**
 * Exhaustively page `GET /v1/billing/alerts`, optionally scoped to a single
 * meter. Bounded at {@link MAX_PAGES} pages of 100 so a misbehaving cursor
 * fails fast instead of hanging the deploy. Archived alerts are excluded by
 * Stripe itself.
 */
const listAlerts = (meter?: string) =>
  Effect.gen(function* () {
    const alerts: BillingAlert[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* GetBillingAlerts({
        limit: 100,
        ...(meter !== undefined ? { meter } : {}),
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      alerts.push(...response.data);
      const last = response.data[response.data.length - 1];
      if (!response.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return alerts;
  });

/**
 * Alerts have no metadata, so ownership recovery falls back to the natural
 * key `(title, meter, gte)` — the tuple a single logical resource keeps
 * stable, and which changing would have planned a replacement anyway.
 */
const findAlert = (title: string, meter: string, gte: number) =>
  Effect.gen(function* () {
    const alerts = yield* listAlerts(meter);
    return alerts.find(
      (alert) =>
        alert.status !== "archived" &&
        alert.title === title &&
        alert.usage_threshold !== null &&
        alert.usage_threshold.gte === gte &&
        meterIdOf(alert.usage_threshold.meter) === meter,
    );
  });
