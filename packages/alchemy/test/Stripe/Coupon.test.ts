import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetCouponsCoupon } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Deterministic, human-typed coupon id. Reused across runs so a rerun
 * converges onto the same object rather than accumulating garbage.
 */
const PINNED_ID = "alchemy-test-coupon-pinned";

test.provider("create and delete a coupon with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const coupon = yield* stack.deploy(
      Stripe.Coupon("MinimalCoupon", {
        percentOff: 25,
      }),
    );

    expect(coupon.couponId).toBeDefined();
    expect(coupon.percentOff).toEqual(25);
    // Stripe's documented default when `duration` is omitted.
    expect(coupon.duration).toEqual("once");
    expect(coupon.valid).toEqual(true);
    expect(coupon.timesRedeemed).toEqual(0);
    // Alchemy's branding keys never leak into the user-facing attribute.
    expect(coupon.metadata).toEqual({});

    const fetched = yield* GetCouponsCoupon({ coupon: coupon.couponId });
    expect(fetched.percent_off).toEqual(25);
    expect(fetched.metadata?.alchemy_id).toEqual("MinimalCoupon");

    yield* stack.destroy();

    const afterDelete = yield* Effect.result(
      GetCouponsCoupon({ coupon: coupon.couponId }),
    );
    expect(Result.isFailure(afterDelete)).toBe(true);
  }),
);

test.provider("create a coupon with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const coupon = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("FullCouponProduct", {
          name: "Alchemy Coupon Test Product",
        });
        return yield* Stripe.Coupon("FullCoupon", {
          id: PINNED_ID,
          name: "Alchemy Full Coupon",
          amountOff: 1000,
          currency: "usd",
          duration: "repeating",
          durationInMonths: 3,
          maxRedemptions: 5,
          // 2030-01-01T00:00:00Z — a fixed timestamp, never `Date.now()`.
          redeemBy: 1893456000,
          appliesTo: { products: [product.productId] },
          currencyOptions: { eur: { amountOff: 900 } },
          metadata: { campaign: "full-surface" },
        });
      }),
    );

    expect(coupon.couponId).toEqual(PINNED_ID);
    expect(coupon.name).toEqual("Alchemy Full Coupon");
    expect(coupon.amountOff).toEqual(1000);
    expect(coupon.currency).toEqual("usd");
    expect(coupon.duration).toEqual("repeating");
    expect(coupon.durationInMonths).toEqual(3);
    expect(coupon.maxRedemptions).toEqual(5);
    expect(coupon.redeemBy).toEqual(1893456000);
    expect(coupon.appliesToProducts).toHaveLength(1);
    expect(coupon.currencyOptions?.eur?.amountOff).toEqual(900);
    expect(coupon.metadata).toEqual({ campaign: "full-surface" });

    const fetched = yield* GetCouponsCoupon({ coupon: PINNED_ID });
    expect(fetched.amount_off).toEqual(1000);
    expect(fetched.duration).toEqual("repeating");
    expect(fetched.currency_options?.eur?.amount_off).toEqual(900);
    expect(fetched.metadata?.campaign).toEqual("full-surface");
    expect(fetched.metadata?.alchemy_id).toEqual("FullCoupon");

    yield* stack.destroy();
  }),
);

test.provider("update name and metadata in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Coupon("MutableCoupon", {
        percentOff: 10,
        duration: "forever",
        name: "Original Name",
        metadata: { tier: "bronze", retire: "yes" },
      }),
    );
    expect(created.name).toEqual("Original Name");
    expect(created.metadata).toEqual({ tier: "bronze", retire: "yes" });

    const updated = yield* stack.deploy(
      Stripe.Coupon("MutableCoupon", {
        percentOff: 10,
        duration: "forever",
        name: "Renamed Coupon",
        metadata: { tier: "gold" },
      }),
    );

    // `name`, `metadata` and `currencyOptions` are the only mutable fields,
    // so the coupon converges in place.
    expect(updated.couponId).toEqual(created.couponId);
    expect(updated.name).toEqual("Renamed Coupon");
    expect(updated.metadata).toEqual({ tier: "gold" });

    const fetched = yield* GetCouponsCoupon({ coupon: updated.couponId });
    expect(fetched.name).toEqual("Renamed Coupon");
    expect(fetched.metadata?.tier).toEqual("gold");
    // A key the user removed is actually unset on Stripe, not left behind.
    expect(fetched.metadata?.retire).toBeUndefined();
    expect(fetched.metadata?.alchemy_id).toEqual("MutableCoupon");

    yield* stack.destroy();
  }),
);

test.provider("changing an immutable field replaces the coupon", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Coupon("ReplacedCoupon", {
        percentOff: 15,
        duration: "once",
      }),
    );
    expect(created.percentOff).toEqual(15);

    // `percent_off` is immutable by design — Stripe has no update for it.
    const replaced = yield* stack.deploy(
      Stripe.Coupon("ReplacedCoupon", {
        percentOff: 30,
        duration: "once",
      }),
    );

    expect(replaced.couponId).not.toEqual(created.couponId);
    expect(replaced.percentOff).toEqual(30);

    const fetched = yield* GetCouponsCoupon({ coupon: replaced.couponId });
    expect(fetched.percent_off).toEqual(30);

    // The old generation was deleted as part of the replacement.
    const old = yield* Effect.result(
      GetCouponsCoupon({ coupon: created.couponId }),
    );
    expect(Result.isFailure(old)).toBe(true);

    yield* stack.destroy();
  }),
);

test.provider("list enumerates the deployed coupon", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Stripe.Coupon("ListedCoupon", { percentOff: 5, duration: "once" }),
    );

    const provider = yield* Provider.findProvider(Stripe.Coupon);
    const all = yield* provider.list();

    const found = all.find((c) => c.couponId === deployed.couponId);
    expect(found).toBeDefined();
    expect(found?.percentOff).toEqual(5);

    yield* stack.destroy();
  }),
);
