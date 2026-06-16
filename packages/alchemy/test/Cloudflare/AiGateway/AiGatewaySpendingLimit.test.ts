import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { describe } from "vitest";

const { test } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The spending limit is a per-ACCOUNT singleton, so these cases destroy first
// to clear any limit left by a prior run, then drive create -> update -> delete
// and verify each step against the live billing API.

// Both cases drive the same per-account spending-limit singleton; run them serially so one case's amount doesn't leak into the other's read-back under the global concurrent test config.
describe.sequential("AiGatewaySpendingLimit", () => {
  test.provider(
    "create, read-back, and delete the account spending limit",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const cap = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.AiGatewaySpendingLimit("SpendCap", {
              amount: 123_45, // cents -> $123.45
              duration: "monthly",
              topUp: { amount: 10_00 }, // cents -> $10.00 (Cloudflare minimum)
            });
          }),
        );

        expect(cap.amount).toEqual(123_45);
        expect(cap.duration).toEqual("monthly");
        expect(cap.strategy).toEqual("fixed"); // default
        expect(cap.enabled).toEqual(true);
        // Auto recharge defaults to on, with the default $5.00 threshold.
        expect(cap.autoRecharge).toEqual({ amount: 10_00, threshold: 5_00 });

        const live = yield* aiGateway.getBillingSpendingLimit({ accountId });
        expect(live.enabled).toEqual(true);
        expect(live.config.amount).toEqual(123_45);

        const liveRecharge = yield* aiGateway.getBillingTopupConfig({
          accountId,
        });
        expect(liveRecharge.amount).toEqual(10_00);
        expect(liveRecharge.threshold).toEqual(5_00);

        yield* stack.destroy();

        // After delete the account reports no active limit and no
        // auto-recharge config.
        const afterDelete = yield* aiGateway.getBillingSpendingLimit({
          accountId,
        });
        expect(afterDelete.enabled).toEqual(false);
        const rechargeAfterDelete = yield* aiGateway.getBillingTopupConfig({
          accountId,
        });
        expect(rechargeAfterDelete.amount ?? 0).toEqual(0);
      }).pipe(logLevel),
  );

  test.provider("update the spending limit in place", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGatewaySpendingLimit("SpendCap", {
            amount: 100_00, // cents -> $100.00
            duration: "weekly",
            strategy: "fixed",
            topUp: { amount: 10_00 },
          });
        }),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.AiGatewaySpendingLimit("SpendCap", {
            amount: 500_00, // cents -> $500.00
            duration: "monthly",
            strategy: "sliding",
            topUp: { amount: 10_00 },
          });
        }),
      );

      expect(updated.amount).toEqual(500_00);
      expect(updated.duration).toEqual("monthly");
      expect(updated.strategy).toEqual("sliding");

      const live = yield* aiGateway.getBillingSpendingLimit({ accountId });
      expect(live.config.amount).toEqual(500_00);
      expect(live.config.duration).toEqual("monthly");

      yield* stack.destroy();
    }).pipe(logLevel),
  );

  // Canonical `list()` test (per-account singleton): there is no collection
  // API, so `list()` observes the one limit on the ambient account. Deploy a
  // limit, then assert it appears in the enumerated result. Bracket with
  // destroy() at start and end so the test is isolated and leaves no residue.
  test.provider(
    "list enumerates the deployed account spending limit",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const cap = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.AiGatewaySpendingLimit("SpendCap", {
              amount: 234_56, // cents -> $234.56
              duration: "monthly",
              topUp: { amount: 10_00 },
            });
          }),
        );

        const provider = yield* Provider.findProvider(
          Cloudflare.AiGatewaySpendingLimit,
        );
        const all = yield* provider.list();

        expect(all.length).toBeGreaterThan(0);
        const found = all.find((s) => s.accountId === accountId);
        expect(found).toBeDefined();
        expect(found?.accountId).toEqual(cap.accountId);
        expect(found?.amount).toEqual(234_56);
        expect(found?.enabled).toEqual(true);

        yield* stack.destroy();
      }).pipe(logLevel),
  );
});
