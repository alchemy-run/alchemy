import * as SDK from "@distilled.cloud/anthropic";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { adopt } from "@/AdoptPolicy";
import * as Anthropic from "@/Anthropic";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Anthropic.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Spend limits apply to a real organization member, so the suite only runs
// against a member the operator dedicates to it, and only with an Admin API
// key. The daily period is used so a monthly cap the member may carry is
// untouched.
const userId = process.env.ANTHROPIC_TEST_SPEND_LIMIT_USER_ID;
const enabled = !!(process.env.ANTHROPIC_ADMIN_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && !!userId;

/** Out-of-band: resolves once the spend limit is gone. */
const waitUntilGone = (spendLimitId: string) =>
  SDK.getSpendLimit({ spend_limit_id: spendLimitId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

describe.skipIf(!enabled)("Anthropic.SpendLimit", () => {
  test.provider(
    "create, update and delete a member spend limit",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Anthropic.SpendLimit("Daily", {
              userId: userId!,
              amount: 100_000,
              period: "daily",
            });
          }),
        );

        expect(created.spendLimitId).toMatch(/^spl_/);
        expect(created.userId).toBe(userId);
        expect(created.period).toBe("daily");
        expect(created.amount).toBe(100_000);

        const observed = yield* SDK.getSpendLimit({ spend_limit_id: created.spendLimitId });
        expect(observed.amount).toBe("100000");
        expect(observed.period).toBe("daily");
        expect(observed.scope).toMatchObject({ type: "user", user_id: userId });

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Anthropic.SpendLimit("Daily", {
              userId: userId!,
              amount: 200_000,
              period: "daily",
            });
          }),
        );

        expect(updated.spendLimitId).toBe(created.spendLimitId);
        expect(updated.amount).toBe(200_000);
        const reobserved = yield* SDK.getSpendLimit({ spend_limit_id: created.spendLimitId });
        expect(reobserved.amount).toBe("200000");

        yield* stack.destroy();

        expect(yield* waitUntilGone(created.spendLimitId)).toBe("gone");
      }).pipe(logLevel),
    { tags: ["provider:anthropic", "provider:anthropic:spendlimit", "live"], timeout: 120_000 },
  );

  test.provider(
    "a pre-existing limit for the member is only taken over with adoption",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const foreign = yield* SDK.setSpendLimit({
          amount: "150000",
          period: "daily",
          scope: { type: "user", user_id: userId! },
        });

        const app = Effect.gen(function* () {
          return yield* Anthropic.SpendLimit("Adopted", {
            userId: userId!,
            amount: 250_000,
            period: "daily",
          });
        });

        // Without adoption the engine refuses to overwrite the foreign limit.
        expect(Result.isFailure(yield* stack.deploy(app).pipe(Effect.result))).toBe(true);
        const untouched = yield* SDK.getSpendLimit({ spend_limit_id: foreign.id });
        expect(untouched.amount).toBe("150000");

        const adopted = yield* stack.deploy(app.pipe(adopt(true)));
        expect(adopted.spendLimitId).toBe(foreign.id);
        expect(adopted.amount).toBe(250_000);

        yield* stack.destroy();

        expect(yield* waitUntilGone(foreign.id)).toBe("gone");
      }).pipe(logLevel),
    { tags: ["provider:anthropic", "provider:anthropic:spendlimit", "live"], timeout: 120_000 },
  );
});
