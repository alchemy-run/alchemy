import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetPlansPlan } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Every case hangs its plan off a product created in the same stack, so the
 * product's lifecycle is managed too and nothing is orphaned by
 * `stack.destroy()`.
 */
const product = (name: string) => Stripe.Product(name, { name });

/** Assert the plan is gone from Stripe. */
const expectPlanGone = (planId: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(GetPlansPlan({ plan: planId }));
    expect(Result.isFailure(result)).toBe(true);
  });

test.provider("create and delete a minimal plan", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const plan = yield* stack.deploy(
      Effect.gen(function* () {
        const pro = yield* product("PlanMinimalProduct");
        return yield* Stripe.Plan("PlanMinimal", {
          productId: pro.productId,
          currency: "usd",
          interval: "month",
          amount: 2000,
        });
      }),
    );

    expect(plan.planId).toBeDefined();
    expect(plan.currency).toEqual("usd");
    expect(plan.interval).toEqual("month");
    expect(plan.intervalCount).toEqual(1);
    expect(plan.amount).toEqual(2000);
    expect(plan.active).toEqual(true);
    expect(plan.billingScheme).toEqual("per_unit");
    expect(plan.usageType).toEqual("licensed");
    expect(plan.productId).toBeDefined();
    // Alchemy's `alchemy_*` branding never leaks into the user-facing attr.
    expect(plan.metadata).toEqual({});

    const fetched = yield* GetPlansPlan({ plan: plan.planId });
    expect(fetched.id).toEqual(plan.planId);
    expect(fetched.amount).toEqual(2000);
    // The object IS branded in Stripe, which is how a cold `read` finds it.
    expect(fetched.metadata?.alchemy_id).toEqual("PlanMinimal");

    yield* stack.destroy();
    yield* expectPlanGone(plan.planId);
  }),
);

test.provider("create a fully configured tiered metered plan", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const plan = yield* stack.deploy(
      Effect.gen(function* () {
        const pro = yield* product("PlanFullProduct");
        return yield* Stripe.Plan("PlanFull", {
          planId: "alchemy-test-plan-full",
          productId: pro.productId,
          currency: "usd",
          interval: "month",
          intervalCount: 3,
          usageType: "metered",
          billingScheme: "tiered",
          tiersMode: "graduated",
          tiers: [
            { upTo: 1000, unitAmount: 0 },
            { upTo: "inf", unitAmount: 5 },
          ],
          trialPeriodDays: 14,
          nickname: "Alchemy full plan",
          active: true,
          metadata: { team: "billing" },
        });
      }),
    );

    // The user-chosen id is honoured verbatim.
    expect(plan.planId).toEqual("alchemy-test-plan-full");
    expect(plan.intervalCount).toEqual(3);
    expect(plan.usageType).toEqual("metered");
    expect(plan.billingScheme).toEqual("tiered");
    expect(plan.tiersMode).toEqual("graduated");
    expect(plan.trialPeriodDays).toEqual(14);
    expect(plan.nickname).toEqual("Alchemy full plan");
    expect(plan.metadata).toEqual({ team: "billing" });
    expect(plan.tiers).toHaveLength(2);
    expect(plan.tiers?.[0]).toMatchObject({ upTo: 1000, unitAmount: 0 });
    expect(plan.tiers?.[1]).toMatchObject({ upTo: null, unitAmount: 5 });

    const fetched = yield* GetPlansPlan({
      plan: plan.planId,
      expand: ["tiers"],
    });
    expect(fetched.id).toEqual("alchemy-test-plan-full");
    expect(fetched.billing_scheme).toEqual("tiered");
    expect(fetched.tiers_mode).toEqual("graduated");
    expect(fetched.usage_type).toEqual("metered");
    expect(fetched.interval_count).toEqual(3);
    expect(fetched.trial_period_days).toEqual(14);
    expect(fetched.metadata?.team).toEqual("billing");

    yield* stack.destroy();
    yield* expectPlanGone(plan.planId);
  }),
);

test.provider("update mutable fields in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = (props: {
      nickname?: string;
      active?: boolean;
      trialPeriodDays?: number;
      metadata?: Record<string, string>;
    }) =>
      stack.deploy(
        Effect.gen(function* () {
          const pro = yield* product("PlanUpdateProduct");
          return yield* Stripe.Plan("PlanUpdate", {
            productId: pro.productId,
            currency: "usd",
            interval: "month",
            amount: 1500,
            ...props,
          });
        }),
      );

    const created = yield* deploy({
      nickname: "Before",
      trialPeriodDays: 7,
      metadata: { phase: "before", drop: "me" },
    });
    expect(created.nickname).toEqual("Before");
    expect(created.trialPeriodDays).toEqual(7);
    expect(created.active).toEqual(true);
    expect(created.metadata).toEqual({ phase: "before", drop: "me" });

    const updated = yield* deploy({
      nickname: "After",
      trialPeriodDays: 21,
      active: false,
      metadata: { phase: "after" },
    });

    // In-place update: same plan, mutated fields.
    expect(updated.planId).toEqual(created.planId);
    expect(updated.nickname).toEqual("After");
    expect(updated.trialPeriodDays).toEqual(21);
    expect(updated.active).toEqual(false);
    // `drop` disappeared from the desired metadata, so it is unset in Stripe.
    expect(updated.metadata).toEqual({ phase: "after" });
    // Immutable fields are untouched.
    expect(updated.amount).toEqual(1500);
    expect(updated.currency).toEqual("usd");

    const fetched = yield* GetPlansPlan({ plan: updated.planId });
    expect(fetched.nickname).toEqual("After");
    expect(fetched.active).toEqual(false);
    expect(fetched.trial_period_days).toEqual(21);
    expect(fetched.metadata?.phase).toEqual("after");
    expect(fetched.metadata?.drop).toBeUndefined();

    // A redeploy with unchanged props must not churn the plan.
    const again = yield* deploy({
      nickname: "After",
      trialPeriodDays: 21,
      active: false,
      metadata: { phase: "after" },
    });
    expect(again.planId).toEqual(updated.planId);

    yield* stack.destroy();
    yield* expectPlanGone(updated.planId);
  }),
);

test.provider("changing an immutable field replaces the plan", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = (amount: number, interval: "month" | "year") =>
      stack.deploy(
        Effect.gen(function* () {
          const pro = yield* product("PlanReplaceProduct");
          return yield* Stripe.Plan("PlanReplace", {
            productId: pro.productId,
            currency: "usd",
            interval,
            amount,
          });
        }),
      );

    const created = yield* deploy(1000, "month");
    expect(created.amount).toEqual(1000);
    expect(created.interval).toEqual("month");

    // `amount` is fixed at creation — this must produce a NEW plan.
    const replacedAmount = yield* deploy(2500, "month");
    expect(replacedAmount.planId).not.toEqual(created.planId);
    expect(replacedAmount.amount).toEqual(2500);
    // The replaced generation is deleted by the engine.
    yield* expectPlanGone(created.planId);

    // `interval` is fixed too.
    const replacedInterval = yield* deploy(2500, "year");
    expect(replacedInterval.planId).not.toEqual(replacedAmount.planId);
    expect(replacedInterval.interval).toEqual("year");
    yield* expectPlanGone(replacedAmount.planId);

    const fetched = yield* GetPlansPlan({ plan: replacedInterval.planId });
    expect(fetched.interval).toEqual("year");
    expect(fetched.amount).toEqual(2500);

    yield* stack.destroy();
    yield* expectPlanGone(replacedInterval.planId);
  }),
);

test.provider("changing a user-chosen planId replaces the plan", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = (planId: string) =>
      stack.deploy(
        Effect.gen(function* () {
          const pro = yield* product("PlanIdProduct");
          return yield* Stripe.Plan("PlanId", {
            planId,
            productId: pro.productId,
            currency: "usd",
            interval: "month",
            amount: 900,
          });
        }),
      );

    const first = yield* deploy("alchemy-test-plan-id-a");
    expect(first.planId).toEqual("alchemy-test-plan-id-a");

    const second = yield* deploy("alchemy-test-plan-id-b");
    expect(second.planId).toEqual("alchemy-test-plan-id-b");
    yield* expectPlanGone("alchemy-test-plan-id-a");

    yield* stack.destroy();
    yield* expectPlanGone("alchemy-test-plan-id-b");
  }),
);

test.provider("create a plan with an inline product", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const plan = yield* stack.deploy(
      Stripe.Plan("PlanInlineProduct", {
        product: { name: "Alchemy Inline Plan Product" },
        currency: "usd",
        interval: "month",
        amount: 500,
      }),
    );

    expect(plan.planId).toBeDefined();
    expect(plan.productId).toBeDefined();

    const fetched = yield* GetPlansPlan({ plan: plan.planId });
    expect(fetched.id).toEqual(plan.planId);
    expect(fetched.product).toEqual(plan.productId);

    yield* stack.destroy();
    yield* expectPlanGone(plan.planId);
    // NOTE: the inline product is intentionally NOT deleted — Stripe owns it,
    // not Alchemy. This is documented on `PlanProps.product`.
  }),
);
