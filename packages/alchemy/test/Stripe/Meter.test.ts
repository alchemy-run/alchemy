import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetBillingMeters,
  GetBillingMetersId,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

// Stripe reserves a meter's `event_name` for the lifetime of the account and
// never releases it — even after the meter is deactivated. Test event names
// are therefore deterministic constants (never derived from `Date.now()`), and
// re-running a suite re-adopts + reactivates the meter that already owns the
// name rather than creating a duplicate.
const BASIC_EVENT = "alchemy_test_meter_basic";
const FULL_EVENT = "alchemy_test_meter_full";
const UPDATE_EVENT = "alchemy_test_meter_update";
const REPLACE_EVENT_BEFORE = "alchemy_test_meter_replace_before";
const REPLACE_EVENT_AFTER = "alchemy_test_meter_replace_after";
const REVIVE_EVENT = "alchemy_test_meter_revive";

/** Out-of-band lookup of a meter by its account-unique event name. */
const findMeter = (eventName: string) =>
  Effect.gen(function* () {
    const response = yield* GetBillingMeters({ limit: 100 });
    return response.data.find((meter) => meter.event_name === eventName);
  });

test.provider("create a meter with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const meter = yield* stack.deploy(
      Stripe.Meter("BasicMeter", { eventName: BASIC_EVENT }),
    );

    expect(meter.meterId).toBeDefined();
    expect(meter.eventName).toEqual(BASIC_EVENT);
    // `displayName` defaults to the resource's logical ID.
    expect(meter.displayName).toEqual("BasicMeter");
    expect(meter.status).toEqual("active");
    expect(meter.defaultAggregation.formula).toEqual("count");
    expect(meter.customerMapping.eventPayloadKey).toEqual("stripe_customer_id");
    expect(meter.eventTimeWindow).toBeUndefined();
    expect(meter.deactivatedAt).toBeUndefined();

    const fetched = yield* GetBillingMetersId({ id: meter.meterId });
    expect(fetched.event_name).toEqual(BASIC_EVENT);
    expect(fetched.display_name).toEqual("BasicMeter");
    expect(fetched.status).toEqual("active");

    yield* stack.destroy();

    // Meters cannot be deleted — destroying the resource deactivates it, so
    // the object is still readable and still holds its event name.
    const deactivated = yield* GetBillingMetersId({ id: meter.meterId });
    expect(deactivated.status).toEqual("inactive");
    expect(deactivated.event_name).toEqual(BASIC_EVENT);
  }),
);

test.provider("create a meter with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const meter = yield* stack.deploy(
      Stripe.Meter("FullMeter", {
        eventName: FULL_EVENT,
        displayName: "Alchemy full meter",
        defaultAggregation: { formula: "sum" },
        valueSettings: { eventPayloadKey: "bytes" },
        customerMapping: {
          eventPayloadKey: "stripe_customer_id",
          type: "by_id",
        },
        eventTimeWindow: "hour",
      }),
    );

    expect(meter.meterId).toBeDefined();
    expect(meter.displayName).toEqual("Alchemy full meter");
    expect(meter.defaultAggregation.formula).toEqual("sum");
    expect(meter.valueSettings.eventPayloadKey).toEqual("bytes");
    expect(meter.customerMapping.type).toEqual("by_id");
    expect(meter.eventTimeWindow).toEqual("hour");
    expect(meter.livemode).toEqual(false);

    const fetched = yield* GetBillingMetersId({ id: meter.meterId });
    expect(fetched.display_name).toEqual("Alchemy full meter");
    expect(fetched.default_aggregation.formula).toEqual("sum");
    expect(fetched.value_settings.event_payload_key).toEqual("bytes");
    expect(fetched.event_time_window).toEqual("hour");

    yield* stack.destroy();

    const deactivated = yield* GetBillingMetersId({ id: meter.meterId });
    expect(deactivated.status).toEqual("inactive");
  }),
);

test.provider("update displayName in place, preserving the meter", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Meter("UpdateMeter", {
        eventName: UPDATE_EVENT,
        displayName: "Before",
      }),
    );
    expect(created.displayName).toEqual("Before");

    const updated = yield* stack.deploy(
      Stripe.Meter("UpdateMeter", {
        eventName: UPDATE_EVENT,
        displayName: "After",
      }),
    );

    // `display_name` is the only mutable field: the id must survive.
    expect(updated.meterId).toEqual(created.meterId);
    expect(updated.eventName).toEqual(UPDATE_EVENT);
    expect(updated.displayName).toEqual("After");
    expect(updated.status).toEqual("active");

    const fetched = yield* GetBillingMetersId({ id: updated.meterId });
    expect(fetched.display_name).toEqual("After");
    expect(fetched.id).toEqual(created.meterId);

    yield* stack.destroy();
  }),
);

test.provider("changing eventName replaces the meter", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Meter("ReplaceMeter", { eventName: REPLACE_EVENT_BEFORE }),
    );
    expect(created.eventName).toEqual(REPLACE_EVENT_BEFORE);

    const replaced = yield* stack.deploy(
      Stripe.Meter("ReplaceMeter", { eventName: REPLACE_EVENT_AFTER }),
    );

    expect(replaced.meterId).not.toEqual(created.meterId);
    expect(replaced.eventName).toEqual(REPLACE_EVENT_AFTER);
    expect(replaced.status).toEqual("active");

    // The replaced generation is deactivated, not deleted — it keeps its
    // reserved event name forever.
    const old = yield* GetBillingMetersId({ id: created.meterId });
    expect(old.status).toEqual("inactive");
    expect(old.event_name).toEqual(REPLACE_EVENT_BEFORE);

    const fetched = yield* GetBillingMetersId({ id: replaced.meterId });
    expect(fetched.event_name).toEqual(REPLACE_EVENT_AFTER);

    yield* stack.destroy();

    const deactivated = yield* GetBillingMetersId({ id: replaced.meterId });
    expect(deactivated.status).toEqual("inactive");
  }),
);

test.provider("redeploying after destroy reactivates the same meter", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Meter("ReviveMeter", { eventName: REVIVE_EVENT }),
    );
    yield* stack.destroy();

    const inactive = yield* GetBillingMetersId({ id: created.meterId });
    expect(inactive.status).toEqual("inactive");

    // Stripe never releases the event name, so a "fresh" create would fail.
    // Reconcile must find the deactivated meter and reactivate it instead.
    const revived = yield* stack.deploy(
      Stripe.Meter("ReviveMeter", { eventName: REVIVE_EVENT }),
    );
    expect(revived.meterId).toEqual(created.meterId);
    expect(revived.status).toEqual("active");

    const observed = yield* findMeter(REVIVE_EVENT);
    expect(observed?.id).toEqual(created.meterId);
    expect(observed?.status).toEqual("active");

    yield* stack.destroy();
  }),
);
