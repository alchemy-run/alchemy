import {
  type BillingMeter,
  GetBillingMeters,
  GetBillingMetersId,
  PostBillingMeters,
  PostBillingMetersId,
  PostBillingMetersIdDeactivate,
  PostBillingMetersIdReactivate,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * How a meter rolls its events up over a billing period.
 *
 * - `count` — the number of events received.
 * - `sum` — the sum of {@link MeterValueSettings.eventPayloadKey} across events.
 * - `last` — the most recent event's value.
 */
export type MeterAggregationFormula = "count" | "last" | "sum";

/** The window meter events have been pre-aggregated for, if any. */
export type MeterEventTimeWindow = "day" | "hour";

/** A meter is `active` until it is deactivated; deactivation is one-way-ish. */
export type MeterStatus = "active" | "inactive";

/** How a meter event is mapped onto a Stripe Customer. */
export type MeterCustomerMapping = {
  /**
   * The key in the meter event payload that carries the Stripe customer ID.
   *
   * @default "stripe_customer_id"
   */
  eventPayloadKey: string;
  /**
   * The mapping method. Stripe currently only supports `by_id`.
   *
   * @default "by_id"
   */
  type?: "by_id";
};

/** How a meter event's numeric value is extracted from its payload. */
export type MeterValueSettings = {
  /**
   * The key in the meter event payload to read the value from. Required in
   * practice whenever {@link MeterProps.defaultAggregation} is `sum` or
   * `last`.
   *
   * @default "value"
   */
  eventPayloadKey: string;
};

export type MeterProps = {
  /**
   * The name of the meter event this meter aggregates. Corresponds with the
   * `event_name` field on meter events sent to
   * `POST /v1/billing/meter_events`.
   *
   * This is the meter's **natural key**: Stripe requires it to be unique
   * across the account and *never releases it*, even after the meter is
   * deactivated. Changing it replaces the meter.
   */
  eventName: string;
  /**
   * Human-readable name shown in the Stripe dashboard. Not visible to
   * customers. Updated in place.
   *
   * @default - the resource's logical ID
   */
  displayName?: string;
  /**
   * How events are aggregated over the billing period. Cannot be changed
   * after creation — a change replaces the meter.
   *
   * @default { formula: "count" }
   */
  defaultAggregation?: {
    /** Specifies how events are aggregated. */
    formula: MeterAggregationFormula;
  };
  /**
   * How a meter event is mapped onto a Stripe Customer. Cannot be changed
   * after creation — a change replaces the meter.
   *
   * @default { eventPayloadKey: "stripe_customer_id", type: "by_id" }
   */
  customerMapping?: MeterCustomerMapping;
  /**
   * Where in the event payload to read the meter's value from. Cannot be
   * changed after creation — a change replaces the meter.
   *
   * @default { eventPayloadKey: "value" }
   */
  valueSettings?: MeterValueSettings;
  /**
   * Declare that meter events are already pre-aggregated over this window.
   * Cannot be changed after creation — a change replaces the meter.
   *
   * @default undefined - events are not pre-aggregated
   */
  eventTimeWindow?: MeterEventTimeWindow;
};

export type Meter = Resource<
  "Stripe.Meter",
  MeterProps,
  {
    /** Stripe's unique identifier for the meter, e.g. `mtr_…`. */
    meterId: string;
    /** The meter's dashboard name. */
    displayName: string;
    /** The meter event name this meter aggregates. */
    eventName: string;
    /** `active` while the meter accepts events, `inactive` once deactivated. */
    status: MeterStatus;
    /** The observed aggregation settings. */
    defaultAggregation: {
      /** Specifies how events are aggregated. */
      formula: MeterAggregationFormula;
    };
    /** The observed customer-mapping settings. */
    customerMapping: {
      /** The key in the event payload carrying the customer ID. */
      eventPayloadKey: string;
      /** The mapping method. */
      type: string;
    };
    /** The observed value-extraction settings. */
    valueSettings: {
      /** The key in the event payload carrying the value. */
      eventPayloadKey: string;
    };
    /** The pre-aggregation window, when one was configured. */
    eventTimeWindow: MeterEventTimeWindow | undefined;
    /** `true` when the meter lives in live mode rather than test mode. */
    livemode: boolean;
    /** Creation time, in seconds since the Unix epoch. */
    created: number;
    /** Last update time, in seconds since the Unix epoch. */
    updated: number;
    /** Deactivation time, in seconds since the Unix epoch, if deactivated. */
    deactivatedAt: number | undefined;
  },
  never,
  Providers
>;

type MeterAttributes = Meter["Attributes"];

/**
 * A Stripe Billing Meter — the aggregation rule that turns raw usage events
 * into the quantity a usage-based `Price` bills on.
 *
 * Meters have **no `metadata` field**, so Alchemy cannot brand them the way
 * it brands other Stripe objects. A meter's identity is instead its
 * `eventName`, which Stripe requires to be unique per account. After state
 * loss, `read` re-discovers the meter by listing meters and matching
 * `event_name`.
 *
 * Two Stripe behaviours are worth internalising before you use this
 * resource:
 *
 * - **Meters cannot be deleted.** Destroying this resource calls
 *   `POST /v1/billing/meters/{id}/deactivate`, which stops the meter
 *   accepting events and prevents attaching it to new prices. The meter
 *   remains visible in the dashboard and in `GET /v1/billing/meters`
 *   forever. The delete is idempotent — an already-inactive or
 *   already-missing meter is treated as success.
 * - **`eventName` is reserved forever.** A deactivated meter keeps its
 *   event name, so a *fresh* meter can never reuse it. Because changing
 *   `eventName` is a replacement, replacing a meter and then reverting to
 *   the original event name would fail against Stripe — except that this
 *   provider handles it: reconcile looks the event name up first and
 *   **reactivates** the existing meter rather than creating a duplicate.
 *   The practical consequence is that a "recreated" meter is the *same*
 *   Stripe object with its original `created` timestamp and its historical
 *   event data intact.
 *
 * Every property other than `displayName` is immutable — Stripe's update
 * endpoint accepts `display_name` and nothing else — so any other change
 * plans a replacement.
 *
 * ### Creating a Meter
 * **Example:** Count events
 * ```typescript
 * const meter = yield* Stripe.Meter("api-requests", {
 *   eventName: "api_requests",
 * });
 * ```
 *
 * **Example:** Sum a numeric field out of the event payload
 * ```typescript
 * const meter = yield* Stripe.Meter("tokens", {
 *   eventName: "tokens_used",
 *   displayName: "Tokens used",
 *   defaultAggregation: { formula: "sum" },
 *   valueSettings: { eventPayloadKey: "tokens" },
 * });
 * ```
 *
 * **Example:** Fully configured meter
 * ```typescript
 * const meter = yield* Stripe.Meter("bytes-egressed", {
 *   eventName: "bytes_egressed",
 *   displayName: "Bytes egressed",
 *   defaultAggregation: { formula: "sum" },
 *   valueSettings: { eventPayloadKey: "bytes" },
 *   customerMapping: {
 *     eventPayloadKey: "customer_id",
 *     type: "by_id",
 *   },
 *   eventTimeWindow: "hour",
 * });
 * ```
 *
 * ### Alerting on a Meter
 * **Example:** Notify when a customer crosses a usage threshold
 * ```typescript
 * const meter = yield* Stripe.Meter("api-requests", {
 *   eventName: "api_requests",
 * });
 *
 * const alert = yield* Stripe.Alert("api-requests-alert", {
 *   title: "API requests over 10k",
 *   usageThreshold: {
 *     meter: meter.meterId,
 *     gte: 10_000,
 *   },
 * });
 * ```
 *
 * ### Recording usage
 * **Example:** Send a meter event from application code
 * ```typescript
 * // POST https://api.stripe.com/v1/billing/meter_events
 * //   event_name=api_requests
 * //   payload[stripe_customer_id]=cus_123
 * //   payload[value]=1
 * const meter = yield* Stripe.Meter("api-requests", {
 *   eventName: "api_requests",
 * });
 * return { eventName: meter.eventName };
 * ```
 *
 * @see https://docs.stripe.com/api/billing/meter
 *
 * @resource
 */
export const Meter = Resource<Meter>("Stripe.Meter");

/** Stripe's default when `customer_mapping` is omitted at create time. */
const DEFAULT_CUSTOMER_MAPPING_KEY = "stripe_customer_id";
/** Stripe's default when `value_settings` is omitted at create time. */
const DEFAULT_VALUE_PAYLOAD_KEY = "value";
/** Stripe's `default_aggregation` is required; `count` needs no value key. */
const DEFAULT_AGGREGATION_FORMULA: MeterAggregationFormula = "count";
/** Hard bound on list pagination so a bad cursor can never spin forever. */
const MAX_PAGES = 50;

export const MeterProvider = () =>
  Provider.succeed(Meter, {
    stables: ["meterId", "eventName", "created", "livemode"],
    /**
     * `alchemy unsafe nuke` enumerates only **active** meters: a meter can
     * never actually be removed, so listing deactivated ones would make
     * nuke loop reporting "deleted but still there" forever. Deactivating
     * is this resource's delete, and a deactivated meter drops out of this
     * listing — which is exactly the convergence signal nuke wants.
     */
    list: Effect.fn(function* () {
      const meters = yield* listMeters("active");
      return meters.map(meterAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      // `news` is `Input<Props>` during plan — bail out until it resolves.
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // Every field except `display_name` is immutable in Stripe's API:
      // `POST /v1/billing/meters/{id}` accepts `display_name` only.
      if (news.eventName !== output.eventName) {
        return { action: "replace" } as const;
      }
      if (
        (news.defaultAggregation?.formula ?? DEFAULT_AGGREGATION_FORMULA) !==
        output.defaultAggregation.formula
      ) {
        return { action: "replace" } as const;
      }
      if (
        (news.customerMapping?.eventPayloadKey ??
          DEFAULT_CUSTOMER_MAPPING_KEY) !==
        output.customerMapping.eventPayloadKey
      ) {
        return { action: "replace" } as const;
      }
      if (
        (news.customerMapping?.type ?? "by_id") !== output.customerMapping.type
      ) {
        return { action: "replace" } as const;
      }
      if (
        (news.valueSettings?.eventPayloadKey ?? DEFAULT_VALUE_PAYLOAD_KEY) !==
        output.valueSettings.eventPayloadKey
      ) {
        return { action: "replace" } as const;
      }
      if (news.eventTimeWindow !== output.eventTimeWindow) {
        return { action: "replace" } as const;
      }
      // `displayName` is the only mutable aspect — let the engine plan the
      // default update rather than short-circuiting to a no-op here.
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (output?.meterId) {
        const observed = yield* getMeter(output.meterId);
        if (observed) return meterAttributes(observed);
      }
      // State loss (or a stale id): meters carry no metadata, so the only
      // way back to the object is its account-unique `event_name`.
      const eventName = olds?.eventName;
      if (!eventName) return undefined;
      const observed = yield* findMeterByEventName(eventName);
      return observed ? meterAttributes(observed) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const displayName = news.displayName ?? id;

      // 1. Observe — the cached id first, then fall back to the natural key
      //    so a create whose state write failed is adopted rather than
      //    duplicated (and so a *deactivated* meter holding this event name
      //    is found instead of colliding on create).
      let observed = output?.meterId
        ? yield* getMeter(output.meterId)
        : undefined;
      if (observed === undefined) {
        observed = yield* findMeterByEventName(news.eventName);
      }

      // 2. Ensure — create when genuinely missing. A concurrent create that
      //    grabbed the event name first surfaces as an InvalidRequestError;
      //    re-resolve by event name and continue rather than failing.
      if (observed === undefined) {
        observed = yield* PostBillingMeters({
          display_name: displayName,
          event_name: news.eventName,
          default_aggregation: {
            formula:
              news.defaultAggregation?.formula ?? DEFAULT_AGGREGATION_FORMULA,
          },
          ...(news.customerMapping !== undefined
            ? {
                customer_mapping: {
                  event_payload_key: news.customerMapping.eventPayloadKey,
                  type: news.customerMapping.type ?? "by_id",
                },
              }
            : {}),
          ...(news.valueSettings !== undefined
            ? {
                value_settings: {
                  event_payload_key: news.valueSettings.eventPayloadKey,
                },
              }
            : {}),
          ...(news.eventTimeWindow !== undefined
            ? { event_time_window: news.eventTimeWindow }
            : {}),
        }).pipe(
          Effect.catchTag("InvalidRequestError", (error) =>
            findMeterByEventName(news.eventName).pipe(
              Effect.flatMap((raced) =>
                raced !== undefined
                  ? Effect.succeed(raced)
                  : Effect.fail(error),
              ),
            ),
          ),
        );
      }

      // 3. Sync — the desired state of a deployed meter is "active", so a
      //    meter left inactive by a previous destroy is reactivated.
      if (observed.status === "inactive") {
        observed = yield* PostBillingMetersIdReactivate({ id: observed.id });
      }
      // The only mutable field; skip the API call entirely on a no-op.
      if (observed.display_name !== displayName) {
        observed = yield* PostBillingMetersId({
          id: observed.id,
          display_name: displayName,
        });
      }

      return meterAttributes(observed);
    }),
    /**
     * Stripe has no delete endpoint for meters — destroying this resource
     * deactivates the meter instead. Idempotent: an already-inactive or
     * already-missing meter is a no-op.
     */
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* getMeter(output.meterId);
      if (observed === undefined || observed.status === "inactive") return;
      yield* PostBillingMetersIdDeactivate({ id: output.meterId }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (error) =>
          error.code === "resource_missing" ? Effect.void : Effect.fail(error),
        ),
      );
    }),
  });

/** Map a Stripe `billing.meter` onto this resource's Attributes shape. */
const meterAttributes = (meter: BillingMeter): MeterAttributes => ({
  meterId: meter.id,
  displayName: meter.display_name,
  eventName: meter.event_name,
  status: meter.status,
  defaultAggregation: { formula: meter.default_aggregation.formula },
  customerMapping: {
    eventPayloadKey: meter.customer_mapping.event_payload_key,
    type: meter.customer_mapping.type,
  },
  valueSettings: {
    eventPayloadKey: meter.value_settings.event_payload_key,
  },
  eventTimeWindow: meter.event_time_window ?? undefined,
  livemode: meter.livemode,
  created: meter.created,
  updated: meter.updated,
  deactivatedAt: meter.status_transitions.deactivated_at ?? undefined,
});

/**
 * Fetch a meter by id, mapping "no such object" onto `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing`, and distilled dispatches on `error.type` before HTTP
 * status — so the miss can surface as either `NotFound` or
 * `InvalidRequestError` depending on the response shape. Both are handled.
 */
const getMeter = (meterId: string) =>
  GetBillingMetersId({ id: meterId }).pipe(
    Effect.map((meter): BillingMeter | undefined => meter),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/**
 * Exhaustively page `GET /v1/billing/meters`, optionally filtered by status.
 * Bounded at {@link MAX_PAGES} pages of 100 so a misbehaving cursor fails
 * fast instead of hanging the deploy.
 */
const listMeters = (status?: MeterStatus) =>
  Effect.gen(function* () {
    const meters: BillingMeter[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* GetBillingMeters({
        limit: 100,
        ...(status !== undefined ? { status } : {}),
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      meters.push(...response.data);
      const last = response.data[response.data.length - 1];
      if (!response.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return meters;
  });

/**
 * Find the meter holding `eventName`. Deliberately unfiltered by status:
 * Stripe reserves an event name for the life of the account, so a
 * deactivated meter still owns it and must be found (and reactivated)
 * rather than collided with.
 */
const findMeterByEventName = (eventName: string) =>
  Effect.gen(function* () {
    const meters = yield* listMeters();
    return meters.find((meter) => meter.event_name === eventName);
  });
