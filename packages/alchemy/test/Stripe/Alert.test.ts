import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetBillingAlerts,
  GetBillingAlertsId,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

// Meter event names are reserved account-wide by Stripe forever, so each test
// owns a distinct deterministic name (never derived from `Date.now()`).
const BASIC_METER_EVENT = "alchemy_test_alert_basic";
const FULL_METER_EVENT = "alchemy_test_alert_full";
const REPLACE_METER_EVENT = "alchemy_test_alert_replace";
const ARCHIVE_METER_EVENT = "alchemy_test_alert_archive";
const TITLE_METER_EVENT = "alchemy_test_alert_title";

/**
 * Out-of-band lookup of every non-archived alert on a meter. Stripe drops
 * archived alerts from this listing entirely, which is how the tests assert
 * that a destroy actually archived the alert.
 */
const listAlerts = (meter: string) =>
  Effect.gen(function* () {
    const response = yield* GetBillingAlerts({ meter, limit: 100 });
    return response.data;
  });

test.provider("create an alert with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { meter, alert } = yield* stack.deploy(
      Effect.gen(function* () {
        const meter = yield* Stripe.Meter("BasicAlertMeter", {
          eventName: BASIC_METER_EVENT,
        });
        const alert = yield* Stripe.Alert("BasicAlert", {
          usageThreshold: { meter: meter.meterId, gte: 10_000 },
        });
        return { meter, alert };
      }),
    );

    expect(alert.alertId).toBeDefined();
    // `title` defaults to the resource's logical ID.
    expect(alert.title).toEqual("BasicAlert");
    expect(alert.alertType).toEqual("usage_threshold");
    expect(alert.status).toEqual("active");
    expect(alert.livemode).toEqual(false);
    expect(alert.usageThreshold?.meterId).toEqual(meter.meterId);
    expect(alert.usageThreshold?.gte).toEqual(10_000);
    expect(alert.usageThreshold?.recurrence).toEqual("one_time");
    expect(alert.usageThreshold?.filters).toEqual([]);

    const fetched = yield* GetBillingAlertsId({ id: alert.alertId });
    expect(fetched.title).toEqual("BasicAlert");
    expect(fetched.alert_type).toEqual("usage_threshold");
    expect(fetched.usage_threshold?.gte).toEqual(10_000);

    yield* stack.destroy();

    // Alerts cannot be deleted — destroy archives them, which removes them
    // from `GET /v1/billing/alerts`.
    const remaining = yield* listAlerts(meter.meterId);
    expect(remaining.find((a) => a.id === alert.alertId)).toBeUndefined();
  }),
);

test.provider("create an alert with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { meter, alert } = yield* stack.deploy(
      Effect.gen(function* () {
        const meter = yield* Stripe.Meter("FullAlertMeter", {
          eventName: FULL_METER_EVENT,
          defaultAggregation: { formula: "sum" },
          valueSettings: { eventPayloadKey: "bytes" },
        });
        const alert = yield* Stripe.Alert("FullAlert", {
          title: "Alchemy full alert",
          alertType: "usage_threshold",
          usageThreshold: {
            meter: meter.meterId,
            gte: 500_000,
            recurrence: "one_time",
          },
        });
        return { meter, alert };
      }),
    );

    expect(alert.title).toEqual("Alchemy full alert");
    expect(alert.usageThreshold?.meterId).toEqual(meter.meterId);
    expect(alert.usageThreshold?.gte).toEqual(500_000);
    expect(alert.usageThreshold?.recurrence).toEqual("one_time");

    const fetched = yield* GetBillingAlertsId({ id: alert.alertId });
    expect(fetched.title).toEqual("Alchemy full alert");
    expect(fetched.status).toEqual("active");
    expect(fetched.usage_threshold?.gte).toEqual(500_000);

    yield* stack.destroy();

    const remaining = yield* listAlerts(meter.meterId);
    expect(remaining.find((a) => a.id === alert.alertId)).toBeUndefined();
  }),
);

test.provider("redeploying an unchanged alert is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Effect.gen(function* () {
        const meter = yield* Stripe.Meter("ArchiveAlertMeter", {
          eventName: ARCHIVE_METER_EVENT,
        });
        const alert = yield* Stripe.Alert("StableAlert", {
          title: "Alchemy stable alert",
          usageThreshold: { meter: meter.meterId, gte: 2_500 },
        });
        return { meter, alert };
      }),
    );

    const created = yield* deploy;
    expect(created.alert.alertId).toBeDefined();

    // Alerts are fully immutable — an unchanged deploy must neither replace
    // the alert nor attempt an (nonexistent) update endpoint.
    const again = yield* deploy;
    expect(again.alert.alertId).toEqual(created.alert.alertId);
    expect(again.alert.title).toEqual("Alchemy stable alert");
    expect(again.alert.status).toEqual("active");

    const fetched = yield* GetBillingAlertsId({ id: again.alert.alertId });
    expect(fetched.id).toEqual(created.alert.alertId);

    yield* stack.destroy();

    const remaining = yield* listAlerts(created.meter.meterId);
    expect(
      remaining.find((a) => a.id === created.alert.alertId),
    ).toBeUndefined();
  }),
);

test.provider("changing the threshold replaces the alert", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const meter = yield* Stripe.Meter("ReplaceAlertMeter", {
          eventName: REPLACE_METER_EVENT,
        });
        const alert = yield* Stripe.Alert("ReplaceAlert", {
          title: "Alchemy replace alert",
          usageThreshold: { meter: meter.meterId, gte: 1_000 },
        });
        return { meter, alert };
      }),
    );
    expect(created.alert.usageThreshold?.gte).toEqual(1_000);

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const meter = yield* Stripe.Meter("ReplaceAlertMeter", {
          eventName: REPLACE_METER_EVENT,
        });
        const alert = yield* Stripe.Alert("ReplaceAlert", {
          title: "Alchemy replace alert",
          usageThreshold: { meter: meter.meterId, gte: 2_000 },
        });
        return { meter, alert };
      }),
    );

    // Every field on an alert is immutable, so `gte` forces a replacement.
    expect(replaced.alert.alertId).not.toEqual(created.alert.alertId);
    expect(replaced.alert.usageThreshold?.gte).toEqual(2_000);
    // The meter is untouched by the alert's replacement.
    expect(replaced.meter.meterId).toEqual(created.meter.meterId);

    const fetched = yield* GetBillingAlertsId({ id: replaced.alert.alertId });
    expect(fetched.usage_threshold?.gte).toEqual(2_000);

    // The replaced generation is archived, so it disappears from the list.
    const live = yield* listAlerts(created.meter.meterId);
    expect(live.find((a) => a.id === created.alert.alertId)).toBeUndefined();
    expect(live.find((a) => a.id === replaced.alert.alertId)).toBeDefined();

    yield* stack.destroy();

    const remaining = yield* listAlerts(created.meter.meterId);
    expect(
      remaining.find((a) => a.id === replaced.alert.alertId),
    ).toBeUndefined();
  }),
);

test.provider("changing the title replaces the alert", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const meter = yield* Stripe.Meter("TitleAlertMeter", {
          eventName: TITLE_METER_EVENT,
        });
        const alert = yield* Stripe.Alert("TitleAlert", {
          title: "Alchemy title before",
          usageThreshold: { meter: meter.meterId, gte: 4_000 },
        });
        return { meter, alert };
      }),
    );

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const meter = yield* Stripe.Meter("TitleAlertMeter", {
          eventName: TITLE_METER_EVENT,
        });
        const alert = yield* Stripe.Alert("TitleAlert", {
          title: "Alchemy title after",
          usageThreshold: { meter: meter.meterId, gte: 4_000 },
        });
        return { meter, alert };
      }),
    );

    // `title` looks cosmetic but Stripe exposes no update endpoint at all.
    expect(replaced.alert.alertId).not.toEqual(created.alert.alertId);
    expect(replaced.alert.title).toEqual("Alchemy title after");

    const fetched = yield* GetBillingAlertsId({ id: replaced.alert.alertId });
    expect(fetched.title).toEqual("Alchemy title after");

    yield* stack.destroy();

    const remaining = yield* listAlerts(created.meter.meterId);
    expect(
      remaining.find((a) => a.id === replaced.alert.alertId),
    ).toBeUndefined();
  }),
);
