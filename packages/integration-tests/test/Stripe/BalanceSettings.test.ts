import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { withRequestOptions } from "@distilled.cloud/stripe";
import { GetBalanceSettings as GetBalanceSettingsAnyVersion } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Stripe.providers() });

// Balance settings nest under `payments` only from the SDK spec's API version.
const GetBalanceSettings = (input: {}) =>
  GetBalanceSettingsAnyVersion(input).pipe(withRequestOptions({ apiVersion: "2026-10-28.endive" }));

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "manage the payout schedule and restore it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const before = yield* GetBalanceSettings({});
      const originalSchedule = before.payments.payouts?.schedule;
      const originalDescriptor = before.payments.payouts?.statement_descriptor ?? null;

      const deploy = (payouts: Stripe.BalanceSettingsPayouts) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.BalanceSettings("Balance", { payments: { payouts } });
          }),
        );

      const weekly = yield* deploy({
        schedule: { interval: "weekly", weeklyPayoutDays: ["friday"] },
        statementDescriptor: "ALCHEMY PAYOUT",
      });
      expect(weekly.payments.payouts?.schedule).toMatchObject({
        interval: "weekly",
        weeklyPayoutDays: ["friday"],
      });
      expect(weekly.payments.payouts?.statementDescriptor).toEqual("ALCHEMY PAYOUT");

      const fetched = yield* GetBalanceSettings({});
      expect(fetched.payments.payouts?.schedule?.interval).toEqual("weekly");
      expect(fetched.payments.payouts?.statement_descriptor).toEqual("ALCHEMY PAYOUT");

      const monthly = yield* deploy({
        schedule: { interval: "monthly", monthlyPayoutDays: [15] },
        statementDescriptor: "ALCHEMY MONTHLY",
      });
      expect(monthly.payments.payouts?.schedule).toMatchObject({
        interval: "monthly",
        monthlyPayoutDays: [15],
      });
      // The snapshot is taken once: the second deploy doesn't capture the
      // values the first one wrote.
      expect(monthly.initialPayments.payouts?.schedule?.interval).toEqual(
        weekly.initialPayments.payouts?.schedule?.interval,
      );
      expect(monthly.initialPayments.payouts?.statementDescriptor).toEqual(
        weekly.initialPayments.payouts?.statementDescriptor,
      );
      expect(weekly.initialPayments.payouts?.statementDescriptor ?? null).toEqual(
        originalDescriptor,
      );

      yield* stack.destroy();

      const after = yield* GetBalanceSettings({});
      expect(after.payments.payouts?.schedule?.interval).toEqual(originalSchedule?.interval);
      expect(after.payments.payouts?.statement_descriptor ?? null).toEqual(originalDescriptor);
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:balancesettings", "live"],
    timeout: 120_000,
    exclusive: "stripe:balance-settings",
  },
);
