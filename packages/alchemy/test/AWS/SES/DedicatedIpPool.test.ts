import * as AWS from "@/AWS";
import { DedicatedIpPool } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class PoolStillExists extends Data.TaggedError("PoolStillExists")<{
  readonly name: string;
}> {}

const getPool = (name: string) =>
  sesv2.getDedicatedIpPool({ PoolName: name }).pipe(
    Effect.map((response) => response.DedicatedIpPool),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

const assertPoolDeleted = (name: string) =>
  getPool(name).pipe(
    Effect.flatMap((found) =>
      found ? Effect.fail(new PoolStillExists({ name })) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "PoolStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Dedicated IP pools provision dedicated IP capacity and bill immediately, so
// the entire lifecycle is gated behind AWS_TEST_SES_DEDICATED_IP=1. Nothing in
// this suite creates a pool unless that flag is set — there is no ungated
// probe.
test.provider.skipIf(!process.env.AWS_TEST_SES_DEDICATED_IP)(
  "dedicated IP pool lifecycle: create STANDARD, scale to MANAGED, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const pool = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Marketing", {
            scalingMode: "STANDARD",
          });
        }),
      );

      expect(pool.poolName).toBeDefined();
      expect(pool.scalingMode).toBe("STANDARD");

      // out-of-band verification via distilled
      const created = yield* getPool(pool.poolName);
      expect(created?.ScalingMode).toBe("STANDARD");

      // STANDARD -> MANAGED is an in-place scaling change (no replacement).
      const scaled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Marketing", {
            scalingMode: "MANAGED",
          });
        }),
      );
      expect(scaled.poolName).toBe(pool.poolName);
      expect(scaled.scalingMode).toBe("MANAGED");
      const observed = yield* getPool(pool.poolName);
      expect(observed?.ScalingMode).toBe("MANAGED");

      yield* stack.destroy();
      yield* assertPoolDeleted(pool.poolName);
    }),
  { timeout: 120_000 },
);

// MANAGED -> STANDARD is not supported by AWS in place, so it replaces the
// pool. Auto-naming gives the replacement a fresh instance suffix.
test.provider.skipIf(!process.env.AWS_TEST_SES_DEDICATED_IP)(
  "downgrading MANAGED -> STANDARD replaces the pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Pool", { scalingMode: "MANAGED" });
        }),
      );

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DedicatedIpPool("Pool", { scalingMode: "STANDARD" });
        }),
      );

      expect(second.poolName).not.toBe(first.poolName);
      expect(second.scalingMode).toBe("STANDARD");
      yield* assertPoolDeleted(first.poolName);

      yield* stack.destroy();
      yield* assertPoolDeleted(second.poolName);
    }),
  { timeout: 120_000 },
);
