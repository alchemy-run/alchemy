import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetPromotionCodes,
  GetPromotionCodesPromotionCode,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

// Deterministic customer-facing codes. Stripe frees a code string for reuse
// once the owning promotion code is deactivated, so reruns converge instead
// of colliding.
const FULL_CODE = "ALCHEMYFULL";
const REPLACE_BEFORE = "ALCHEMYBEFORE";
const REPLACE_AFTER = "ALCHEMYAFTER";

test.provider("create a promotion code with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { coupon, code } = yield* stack.deploy(
      Effect.gen(function* () {
        const coupon = yield* Stripe.Coupon("MinimalPromoCoupon", {
          percentOff: 20,
          duration: "once",
        });
        const code = yield* Stripe.PromotionCode("MinimalPromoCode", {
          couponId: coupon.couponId,
        });
        return { coupon, code };
      }),
    );

    expect(code.promotionCodeId).toBeDefined();
    expect(code.couponId).toEqual(coupon.couponId);
    // Stripe generates the customer-facing string when `code` is omitted.
    expect(code.code).toBeDefined();
    expect(code.active).toEqual(true);
    expect(code.timesRedeemed).toEqual(0);
    expect(code.restrictions.firstTimeTransaction).toEqual(false);
    // Alchemy's branding keys never leak into the user-facing attribute.
    expect(code.metadata).toEqual({});

    const fetched = yield* GetPromotionCodesPromotionCode({
      promotion_code: code.promotionCodeId,
    });
    expect(fetched.active).toEqual(true);
    expect(fetched.metadata?.alchemy_id).toEqual("MinimalPromoCode");

    yield* stack.destroy();
  }),
);

test.provider("create a promotion code with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const code = yield* stack.deploy(
      Effect.gen(function* () {
        const coupon = yield* Stripe.Coupon("FullPromoCoupon", {
          amountOff: 2000,
          currency: "usd",
          duration: "once",
          maxRedemptions: 10,
        });
        return yield* Stripe.PromotionCode("FullPromoCode", {
          couponId: coupon.couponId,
          code: FULL_CODE,
          // 2030-01-01T00:00:00Z — a fixed timestamp, never `Date.now()`.
          expiresAt: 1893456000,
          maxRedemptions: 3,
          restrictions: {
            firstTimeTransaction: true,
            minimumAmount: 5000,
            minimumAmountCurrency: "usd",
          },
          metadata: { campaign: "full-surface", retire: "yes" },
        });
      }),
    );

    expect(code.code).toEqual(FULL_CODE);
    expect(code.expiresAt).toEqual(1893456000);
    expect(code.maxRedemptions).toEqual(3);
    expect(code.restrictions.firstTimeTransaction).toEqual(true);
    expect(code.restrictions.minimumAmount).toEqual(5000);
    expect(code.restrictions.minimumAmountCurrency).toEqual("usd");
    expect(code.metadata).toEqual({ campaign: "full-surface", retire: "yes" });

    const fetched = yield* GetPromotionCodesPromotionCode({
      promotion_code: code.promotionCodeId,
    });
    expect(fetched.code).toEqual(FULL_CODE);
    expect(fetched.restrictions.first_time_transaction).toEqual(true);
    expect(fetched.restrictions.minimum_amount).toEqual(5000);
    expect(fetched.metadata?.campaign).toEqual("full-surface");

    yield* stack.destroy();
  }),
);

test.provider("update active and metadata in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const promo = (props: {
      active?: boolean;
      metadata?: Record<string, string>;
    }) =>
      Effect.gen(function* () {
        const coupon = yield* Stripe.Coupon("MutablePromoCoupon", {
          percentOff: 12,
          duration: "forever",
        });
        return yield* Stripe.PromotionCode("MutablePromoCode", {
          couponId: coupon.couponId,
          ...props,
        });
      });

    const created = yield* stack.deploy(
      promo({ metadata: { tier: "bronze", retire: "yes" } }),
    );
    expect(created.active).toEqual(true);
    expect(created.metadata).toEqual({ tier: "bronze", retire: "yes" });

    const updated = yield* stack.deploy(
      promo({ active: false, metadata: { tier: "gold" } }),
    );

    // `active` and `metadata` are the only mutable fields, so the promotion
    // code converges in place.
    expect(updated.promotionCodeId).toEqual(created.promotionCodeId);
    expect(updated.active).toEqual(false);
    expect(updated.metadata).toEqual({ tier: "gold" });

    const fetched = yield* GetPromotionCodesPromotionCode({
      promotion_code: updated.promotionCodeId,
    });
    expect(fetched.active).toEqual(false);
    expect(fetched.metadata?.tier).toEqual("gold");
    // A key the user removed is actually unset on Stripe, not left behind.
    expect(fetched.metadata?.retire).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider(
  "changing an immutable field replaces the promotion code",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const promo = (code: string) =>
        Effect.gen(function* () {
          const coupon = yield* Stripe.Coupon("ReplacedPromoCoupon", {
            percentOff: 18,
            duration: "once",
          });
          return yield* Stripe.PromotionCode("ReplacedPromoCode", {
            couponId: coupon.couponId,
            code,
          });
        });

      const created = yield* stack.deploy(promo(REPLACE_BEFORE));
      expect(created.code).toEqual(REPLACE_BEFORE);

      // The customer-facing `code` is immutable — Stripe's update endpoint
      // does not accept it.
      const replaced = yield* stack.deploy(promo(REPLACE_AFTER));

      expect(replaced.promotionCodeId).not.toEqual(created.promotionCodeId);
      expect(replaced.code).toEqual(REPLACE_AFTER);

      // Stripe cannot delete promotion codes: the old generation survives,
      // deactivated.
      const old = yield* GetPromotionCodesPromotionCode({
        promotion_code: created.promotionCodeId,
      });
      expect(old.active).toEqual(false);

      yield* stack.destroy();
    }),
);

test.provider("destroy deactivates rather than deletes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const code = yield* stack.deploy(
      Effect.gen(function* () {
        const coupon = yield* Stripe.Coupon("ArchivedPromoCoupon", {
          percentOff: 7,
          duration: "once",
        });
        return yield* Stripe.PromotionCode("ArchivedPromoCode", {
          couponId: coupon.couponId,
        });
      }),
    );
    expect(code.active).toEqual(true);

    yield* stack.destroy();

    // The object is still there — only `active` flipped.
    const fetched = yield* GetPromotionCodesPromotionCode({
      promotion_code: code.promotionCodeId,
    });
    expect(fetched.active).toEqual(false);

    // And it is still discoverable by its code string.
    const listed = yield* GetPromotionCodes({ code: fetched.code, limit: 100 });
    expect(listed.data.some((c) => c.id === code.promotionCodeId)).toEqual(
      true,
    );
  }),
);
